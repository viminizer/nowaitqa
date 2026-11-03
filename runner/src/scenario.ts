// Runs one leased scenario on one phone and turns the outcome into a result for the server.
import type { Device, Lease, ResultBody } from '@nowait/shared'
import type { Browser } from 'webdriverio'
import { findScenario } from './catalog.ts'
import { config } from './config.ts'
import { log } from './log.ts'

export async function runScenario(
  driver: Browser,
  device: Device,
  lease: Lease,
): Promise<ResultBody> {
  const started = Date.now()
  const result = { queueId: lease.queueId, device: device.name }

  try {
    const scenario = findScenario(lease.commit, lease.scenarioId)
    if (!scenario) {
      throw new Error(
        `scenario ${lease.scenarioId} at commit ${lease.commit} is not on this runner`,
      )
    }

    await driver.getLogs(logType(device)) // drain old log lines, so the log holds only this scenario
    log(device.name, `run ${lease.runId}: ${lease.scenarioId} (attempt ${lease.attempt})`)
    await closeNotRespondingDialog(driver, device)
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

// Android shows "<app> isn't responding" over every app when a system app hangs for a while (seen
// on a slow emulator: "System UI isn't responding"). The scenario can't see the app under it, and
// fails. Tap "Wait": the hung app goes on, the dialog goes away. A side step: a problem here is
// only logged, and the scenario runs anyway (R50).
async function closeNotRespondingDialog(driver: Browser, device: Device) {
  if (device.platform !== 'android') return
  try {
    const wait = driver.$('android=new UiSelector().resourceId("android:id/aerr_wait")')
    if (!(await wait.isExisting())) return // no waiting: most of the time there is no dialog
    await wait.click()
    log(device.name, 'closed an "isn\'t responding" dialog (tapped Wait)')
  } catch (err) {
    log(device.name, 'could not close an "isn\'t responding" dialog', err)
  }
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
