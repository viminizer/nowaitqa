// Runs the same scenarios twice - fixed split (the old way), then the shared queue - and prints
// how long each took and how long each phone sat idle. The runner must be running.
//   pnpm --filter @nowait/runner benchmark --app <apk path or URL> [--repeat 10] [--platform android]
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import type { RunSummary } from '@nowait/shared'
import { createRun, getRun } from './api.ts'

const { values } = parseArgs({
  options: {
    app: { type: 'string' },
    repeat: { type: 'string', default: '10' },
    platform: { type: 'string', default: 'android' },
  },
})
if (!values.app) throw new Error('--app is required: path or URL of the app build')
if (values.platform !== 'android' && values.platform !== 'ios') {
  throw new Error('--platform must be android or ios')
}
const commit = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim()

async function runAndWait(split: 'fixed' | 'queue'): Promise<RunSummary> {
  const id = await createRun({
    platform: values.platform as 'android' | 'ios',
    appBuild: values.app as string,
    commit,
    trigger: 'benchmark',
    split,
    repeat: Number(values.repeat),
  })
  console.log(`${split}: run ${id} started`)
  while (true) {
    const run = await getRun(id)
    if (run.status !== 'running') return run
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
}

const seconds = (ms: number | null) => (ms === null ? '-' : `${Math.round(ms / 1000)}s`)

function print(run: RunSummary) {
  console.log(`\n${run.split}: ${run.status}, total ${seconds(run.durationMs)}`)
  console.table(
    run.devices.map((d) => ({
      phone: d.name,
      attempts: d.attempts,
      busy: seconds(d.busyMs),
      idle: seconds(d.idleMs),
    })),
  )
}

const fixed = await runAndWait('fixed')
const shared = await runAndWait('queue')
print(fixed)
print(shared)

if (fixed.durationMs && shared.durationMs) {
  const saved = 1 - shared.durationMs / fixed.durationMs
  console.log(`\nshared queue was ${Math.round(saved * 100)}% faster than the fixed split`)
}
