// Runs one leased scenario on one phone and turns the outcome into a result for the server.
import { execFileSync } from 'node:child_process'
import type { Catalog, Device, Lease, ResultBody } from '@nowait/shared'
import { loadScenarios } from '@nowait-qa/sdk'
import type { Browser } from 'webdriverio'
import { config } from './config.ts'
import { log } from './log.ts'

// The scenarios and their git commit are read once at startup: restart the runner after a pull.
const scenarios = new Map((await loadScenarios(config.SCENARIOS_DIR)).map((s) => [s.id, s]))
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: config.SCENARIOS_DIR })
  .toString()
  .trim()

// What the runner tells the server it can run. The server only leases it work from this commit.
export const catalog: Catalog = {
  commit: head,
  scenarios: [...scenarios.values()].map(({ id, platforms }) => ({ id, platforms })),
}

export async function runScenario(
  driver: Browser,
  device: Device,
  lease: Lease,
): Promise<ResultBody> {
  const started = Date.now()
  const result = { queueId: lease.queueId, device: device.name }

  try {
    const scenario = scenarios.get(lease.scenarioId)
    if (!scenario) throw new Error(`scenario ${lease.scenarioId} not found on this runner`)

    await driver.getLogs(logType(device)) // drain old log lines, so the log holds only this scenario
    log(device.name, `run ${lease.runId}: ${lease.scenarioId} (attempt ${lease.attempt})`)
    await withTimeout(scenario.run(driver, account(lease)), config.SCENARIO_TIMEOUT_SECONDS)
    return { ...result, status: 'passed', durationMs: Date.now() - started }
  } catch (err) {
    log(device.name, `${lease.scenarioId} failed`, err)
    return {
      ...result,
      status: 'failed',
      durationMs: Date.now() - started,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
      ...(await capture(driver, device)),
    }
  }
}

function account(lease: Lease) {
  if (!lease.account) return null
  if (!config.TEST_ACCOUNT_PASSWORD) throw new Error('TEST_ACCOUNT_PASSWORD is not set')
  return { username: lease.account, password: config.TEST_ACCOUNT_PASSWORD }
}

function logType(device: Device) {
  return device.platform === 'android' ? 'logcat' : 'syslog'
}

// Screenshot and the device log at the moment of failure. A capture problem is written into the
// log instead, so it never hides the real failure.
async function capture(driver: Browser, device: Device) {
  const notes: string[] = []
  const screenshot = await driver.takeScreenshot().catch((err) => {
    notes.push(`screenshot failed: ${err}`)
    return undefined
  })
  const lines = await driver.getLogs(logType(device)).catch((err) => {
    notes.push(`device log failed: ${err}`)
    return []
  })
  const deviceLog = (lines as { timestamp: number; message: string }[])
    .slice(-500)
    .map((l) => `${new Date(l.timestamp).toISOString()} ${l.message}`)
  return { screenshot, log: [...notes, ...deviceLog].join('\n') }
}

function withTimeout(work: Promise<void>, seconds: number) {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${seconds}s`)), seconds * 1000)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}
