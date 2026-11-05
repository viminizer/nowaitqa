// Which scenarios this runner has. Either SCENARIOS_DIR as it is (read once), or, with
// SCENARIOS_REPO, a checkout per commit that the runner pulls and switches to on its own.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { every } from '@nowait/shared'
import { loadScenarios, type Scenario } from '@nowait-qa/sdk'
import { sendCatalog } from './api.ts'
import { config } from './config.ts'
import { log } from './log.ts'

const exec = promisify(execFile)
let catalogSignal: AbortSignal | undefined
const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', args, { cwd, signal: catalogSignal })).stdout.trim()

type Version = { commit: string; dir: string; scenarios: Map<string, Scenario> }

// Newest first. The previous version stays, so runs started before a pull can still finish.
const versions: Version[] = []

export const commits = () => versions.map((v) => v.commit)

export function findScenarioFile(commit: string, id: string) {
  const version = versions.find((v) => v.commit === commit)
  return version?.scenarios.has(id) ? join(version.dir, `${id}.ts`) : undefined
}

export async function startScenarios(signal?: AbortSignal) {
  catalogSignal = signal
  if (!config.SCENARIOS_REPO) {
    return use(config.SCENARIOS_DIR, await git(config.SCENARIOS_DIR, 'rev-parse', 'HEAD'))
  }
  await mkdir(config.SCENARIOS_DIR, { recursive: true })
  await pull()
  const stop = every(60_000, 'scenario catalog', pull, {
    error: (err, message) => log(config.HOST, message, err),
  })
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) stop()
}

async function use(dir: string, commit: string) {
  const scenarios = new Map((await loadScenarios(dir)).map((s) => [s.id, s]))
  // Tell the server first, so it has the list before any phone asks for work on this commit.
  await sendCatalog(
    {
      commit,
      scenarios: [...scenarios.values()].map(({ id, platforms }) => ({ id, platforms })),
    },
    catalogSignal,
  )
  versions.unshift({ commit, dir, scenarios })
  versions.length = Math.min(versions.length, 2)
  log(config.HOST, `using ${scenarios.size} scenarios at commit ${commit}`)
}

// Fetches the branch. When it moved, checks the new commit out into its own folder (new paths,
// so Node loads the new code instead of its cached modules), installs its packages and switches.
async function pull() {
  const bare = join(config.SCENARIOS_DIR, 'repo.git')
  if (!existsSync(bare)) {
    await git(config.SCENARIOS_DIR, 'clone', '--bare', config.SCENARIOS_REPO as string, bare)
  }
  await git(bare, 'fetch', 'origin', config.SCENARIOS_BRANCH)
  const commit = await git(bare, 'rev-parse', 'FETCH_HEAD')
  if (commit === versions[0]?.commit) return

  const dir = join(config.SCENARIOS_DIR, commit)
  if (!existsSync(dir)) await git(bare, 'worktree', 'add', '--detach', dir, commit)
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) {
    // Dependencies' build scripts are skipped, not an error (webdriverio pulls in browser drivers
    // with build scripts; phones do not need them).
    await exec('pnpm', ['install', '--frozen-lockfile', '--config.strict-dep-builds=false'], {
      cwd: dir,
      signal: catalogSignal,
    })
  }
  await use(dir, commit)

  // ponytail: older checkouts are deleted. A scenario that imports a file lazily, after it
  // started, from a deleted checkout would fail.
  for (const entry of await readdir(config.SCENARIOS_DIR)) {
    if (/^[0-9a-f]{40}$/.test(entry) && !commits().includes(entry)) {
      await git(bare, 'worktree', 'remove', '--force', join(config.SCENARIOS_DIR, entry))
    }
  }
}
