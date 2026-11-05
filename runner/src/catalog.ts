// One managed cache per runner process. Server references protect queued work; local pins
// protect lease requests and executors, including lazy imports after a run has been closed.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { every, FullCommit, messageOf } from '@nowait/shared'
import { loadScenarios, type Scenario } from '@nowait-qa/sdk'
import { z } from 'zod'
import { referencedCommits, sendCatalog } from './api.ts'
import { config } from './config.ts'
import { scenarioIdentity } from './input-files.ts'
import { log } from './log.ts'

const exec = promisify(execFile)
const root = resolve(config.SCENARIOS_DIR)
const bare = join(root, 'repo.git')
let catalogSignal: AbortSignal | undefined
const git = async (cwd: string, ...args: string[]) =>
  (await exec('git', args, { cwd, signal: catalogSignal })).stdout.trim()
const describe = (err: unknown) =>
  config.SCENARIOS_REPO
    ? messageOf(err).replaceAll(config.SCENARIOS_REPO, '[configured repository]')
    : messageOf(err)

type Version = {
  commit: string
  dir: string
  scenarios: Map<string, Scenario>
  pins: number
  retired: boolean
}
const versions = new Map<string, Version>()
export type ScenarioPin = { file: string; release: () => void }
let heads: string[] = [] // current and one warm previous head, when capacity allows
let available: string[] = []

function pin(version: Version) {
  version.pins++
  let released = false
  return () => {
    if (released) return
    released = true
    version.pins--
  }
}

// Pin before HTTP /lease starts. Transfer a selected pin before releasing this snapshot: a
// catalog refresh cannot remove a revision between advertising it and receiving its lease.
export function pinCatalog() {
  const snapshot = available.map((commit) => {
    const version = versions.get(commit)
    if (!version) throw new Error(`advertised revision ${commit} is unavailable`)
    return version
  })
  const releaseAll = snapshot.map(pin)
  let released = false
  return {
    commits: snapshot.map((v) => v.commit),
    scenario(commit: string, id: string): ScenarioPin {
      if (released) throw new Error('catalog reservation was already released')
      const version = snapshot.find((v) => v.commit === commit)
      if (!version?.scenarios.has(id))
        throw new Error(`scenario ${id} at revision ${commit} is unavailable on this runner`)
      return { file: join(version.dir, `${id}.ts`), release: pin(version) }
    },
    release() {
      released = true
      for (const release of releaseAll) release()
    },
  }
}

function advertise(required: Set<string>) {
  available = [...new Set([...heads, ...required])].filter((commit) => {
    const version = versions.get(commit)
    return version && !version.retired
  })
}

async function publish(version: Version) {
  await sendCatalog(
    {
      commit: version.commit,
      scenarios: [...version.scenarios.values()].map(({ id, platforms }) => ({ id, platforms })),
    },
    catalogSignal,
  )
  heads = [version.commit, ...heads.filter((c) => c !== version.commit)].slice(0, 2)
}

export async function startScenarios(signal?: AbortSignal) {
  catalogSignal = signal
  if (!config.SCENARIOS_REPO) {
    const commit = FullCommit.parse(await git(root, 'rev-parse', 'HEAD'))
    await scenarioIdentity(root, commit, signal)
    const version = {
      commit,
      dir: root,
      scenarios: new Map((await loadScenarios(root)).map((s) => [s.id, s])),
      pins: 0,
      retired: false,
    }
    versions.set(commit, version)
    await publish(version)
    advertise(new Set())
    return
  }
  await mkdir(root, { recursive: true })
  await refresh().catch((err) => {
    if (available.length === 0) throw err
    log(config.HOST, 'some scenario revisions are unavailable; serving ready revisions', err)
  })
  const stop = every(60_000, 'scenario catalog', refresh, {
    error: (err, message) => log(config.HOST, message, err),
  })
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) stop()
}

async function directories() {
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && FullCommit.safeParse(entry.name).success)
    .map((entry) => entry.name)
}

async function bytes() {
  // POSIX runners already require macOS/Linux. Count the whole cache, including Git objects;
  // du does not follow dependency symlinks into the separately managed global package store.
  const { stdout } = await exec('du', ['-sk', root], { signal: catalogSignal })
  return (
    z.coerce
      .number()
      .int()
      .min(0)
      .max(Math.floor(Number.MAX_SAFE_INTEGER / 1024))
      .parse(stdout.trim().split(/\s+/)[0]) * 1024
  )
}

async function prune(keep: Set<string>, errors: string[]) {
  for (const commit of await directories()) {
    if (keep.has(commit)) continue
    const version = versions.get(commit)
    if (version) version.retired = true
    available = available.filter((c) => c !== commit)
    if (version?.pins) continue
    try {
      await git(bare, 'worktree', 'remove', '--force', join(root, commit))
      versions.delete(commit)
    } catch (err) {
      errors.push(`could not reclaim revision ${commit}: ${describe(err)}`)
    }
  }
}

async function room(commit: string, required: Set<string>, errors: string[]) {
  const count = (await directories()).length + (existsSync(join(root, commit)) ? 0 : 1)
  if (count > config.SCENARIO_CACHE_REVISIONS || (await bytes()) >= config.SCENARIO_CACHE_BYTES)
    await prune(new Set([...required, ...heads.slice(0, 1), commit]), errors)
  if (
    (await directories()).length + (existsSync(join(root, commit)) ? 0 : 1) >
    config.SCENARIO_CACHE_REVISIONS
  )
    throw new Error(
      `revision cache limit ${config.SCENARIO_CACHE_REVISIONS} reached; referenced or pinned checkouts were retained`,
    )
  if ((await bytes()) >= config.SCENARIO_CACHE_BYTES)
    throw new Error(
      `scenario cache byte limit ${config.SCENARIO_CACHE_BYTES} reached; referenced or pinned files were retained`,
    )
}

async function prepare(
  commit: string,
  required: Set<string>,
  cleanup: Set<string>,
  errors: string[],
) {
  FullCommit.parse(commit) // never resolve a partial identity to different code silently
  const found = versions.get(commit)
  if (found) {
    found.retired = false
    return found
  }
  const dir = join(root, commit)
  const marker = join(dir, '.nowait-ready')
  const ready = existsSync(marker)
  let created = false
  try {
    if (ready) {
      if (FullCommit.parse((await readFile(marker, 'utf8')).trim()) !== commit)
        throw new Error('checkout readiness identity does not match')
    } else {
      if (existsSync(dir) && cleanup.has(commit))
        throw new Error(
          'cleanup is unconfirmed; an unverified existing checkout will not be modified',
        )
      await room(commit, required, errors)
      if (!existsSync(dir)) {
        try {
          await git(bare, 'rev-parse', '--verify', `${commit}^{commit}`)
        } catch (err) {
          if ((err as { code?: number }).code !== 128) throw err
          await git(bare, 'fetch', 'origin', commit)
        }
        await git(bare, 'worktree', 'prune', '--expire', 'now')
        await git(bare, 'worktree', 'add', '--detach', dir, commit)
        created = true
      }
    }
    if ((await git(dir, 'rev-parse', 'HEAD')) !== commit)
      throw new Error('checkout HEAD does not match its requested revision')
    if (!ready && existsSync(join(dir, 'pnpm-lock.yaml'))) {
      await exec('pnpm', ['install', '--frozen-lockfile', '--config.strict-dep-builds=false'], {
        cwd: dir,
        signal: catalogSignal,
      })
    }
    await scenarioIdentity(dir, commit, catalogSignal)
    const scenarios = new Map((await loadScenarios(dir)).map((s) => [s.id, s]))
    if (!ready) {
      if ((await bytes()) > config.SCENARIO_CACHE_BYTES)
        await prune(new Set([...required, ...heads.slice(0, 1), commit]), errors)
      if ((await bytes()) > config.SCENARIO_CACHE_BYTES)
        throw new Error(
          `prepared checkout exceeds scenario cache byte limit ${config.SCENARIO_CACHE_BYTES}`,
        )
      await writeFile(`${marker}.tmp`, `${commit}\n`)
      await rename(`${marker}.tmp`, marker)
    }
    const version = { commit, dir, scenarios, pins: 0, retired: false }
    versions.set(commit, version)
    return version
  } catch (err) {
    if (created) {
      try {
        await git(bare, 'worktree', 'remove', '--force', dir)
      } catch (cleanupError) {
        errors.push(`could not remove incomplete revision ${commit}: ${describe(cleanupError)}`)
      }
    }
    throw err
  }
}

async function refresh() {
  // An incomplete/outage response is never permission to evict. The API call has an overall
  // deadline and pages all references, including cleanup holds after cancellation/expiry.
  const references = await referencedCommits(catalogSignal)
  const errors: string[] = []
  if (!existsSync(bare)) {
    try {
      await git(root, 'clone', '--bare', config.SCENARIOS_REPO as string, bare)
    } catch (err) {
      throw new Error(`scenario repository unavailable: ${describe(err)}`)
    }
  }
  if (heads.length) await prune(new Set([...references.commits, ...heads]), errors)
  try {
    if ((await bytes()) >= config.SCENARIO_CACHE_BYTES)
      await prune(new Set([...references.commits, ...heads.slice(0, 1)]), errors)
    if ((await bytes()) >= config.SCENARIO_CACHE_BYTES)
      throw new Error(
        `scenario cache byte limit ${config.SCENARIO_CACHE_BYTES} reached; fetch paused`,
      )
    await git(bare, 'fetch', 'origin', config.SCENARIOS_BRANCH)
    const head = FullCommit.parse(await git(bare, 'rev-parse', 'FETCH_HEAD'))
    const version = await prepare(head, references.commits, references.cleanup, errors)
    if (heads[0] !== head) await publish(version)
    advertise(references.commits)
  } catch (err) {
    errors.push(`current branch unavailable: ${describe(err)}`)
  }
  for (const commit of references.commits) {
    try {
      await prepare(commit, references.commits, references.cleanup, errors)
      advertise(references.commits)
    } catch (err) {
      errors.push(`required revision ${commit} unavailable: ${describe(err)}`)
    }
  }
  await prune(new Set([...references.commits, ...heads]), errors)
  advertise(references.commits)
  if (errors.length)
    throw new Error(`${errors.length} scenario cache problem(s): ${errors.slice(0, 5).join('; ')}`)
}
