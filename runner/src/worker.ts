// One worker per phone: take the next scenario, run it, report it, repeat.
import type { Device, Lease } from '@nowait/shared'
import { type Browser, remote } from 'webdriverio'
import { DeviceGoneError, heartbeat, lease, sendResult } from './api.ts'
import { log } from './log.ts'
import { runScenario } from './scenario.ts'

type Session = { driver: Browser; runId: number; appId: string }

// ponytail: after an error the worker pauses, so a broken phone does not fail the whole queue.
// A smarter health check can come later.
const ERROR_PAUSE_MS = 60_000

export async function runWorker(device: Device) {
  log(device.name, 'worker started')
  let session: Session | null = null

  while (true) {
    let current: Lease | null = null
    let stopHeartbeat = () => {}
    try {
      current = await lease(device.name, session?.runId)
      if (!current) continue
      // From the moment we hold the lease: a first app install can take minutes.
      // If the lease is gone, ending the Appium session stops the scenario at its next command.
      stopHeartbeat = keepLeaseAlive(device, current, () => closeSession(device, session))

      // One session per phone for the whole run. A new run brings a new app build.
      if (session?.runId === current.runId) {
        await resetApp(session)
      } else {
        await closeSession(device, session)
        session = null
        session = await openSession(device, current)
      }

      const result = await runScenario(session.driver, device, current)
      stopHeartbeat()
      const saved = await sendResult(result)
      if (!saved) log(device.name, `result for ${current.scenarioId} ignored: the lease was gone`)

      // After a failure the app may be in a strange state: start clean next time.
      if (result.status === 'failed') {
        await closeSession(device, session)
        session = null
      }
    } catch (err) {
      stopHeartbeat()
      await closeSession(device, session)
      session = null
      if (err instanceof DeviceGoneError) {
        log(device.name, 'worker stopped', err.message)
        return
      }
      log(device.name, 'worker error', err)
      if (current) await reportRunnerError(device, current, err)
      await new Promise((resolve) => setTimeout(resolve, ERROR_PAUSE_MS))
    }
  }
}

// Tells the server "still working" four times per lease period, and calls onGone once if the
// lease is gone (it expired, or the run was stuck and closed). Returns the stop function.
function keepLeaseAlive(device: Device, current: Lease, onGone: () => Promise<void>) {
  const timer = setInterval(
    () => {
      heartbeat(current.queueId, device.name)
        .then(async (alive) => {
          if (alive) return
          clearInterval(timer)
          log(device.name, `lease ${current.queueId} is gone: stopping the scenario`)
          await onGone()
        })
        .catch((err) => log(device.name, 'heartbeat failed', err))
    },
    (current.leaseSeconds * 1000) / 4,
  )
  return () => clearInterval(timer)
}

async function openSession(device: Device, lease: Lease): Promise<Session> {
  if (device.platform !== 'android') throw new Error('iOS is not supported yet')
  const url = new URL(device.appiumUrl)
  const driver = await remote({
    protocol: url.protocol.replace(':', ''),
    hostname: url.hostname,
    port: Number(url.port),
    path: url.pathname,
    logLevel: 'warn',
    waitforTimeout: 15_000, // how long waitForDisplayed and friends wait; phones can be slow
    capabilities: {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:udid': device.udid,
      'appium:systemPort': device.systemPort,
      'appium:app': lease.appBuild,
      'appium:autoGrantPermissions': true,
      'appium:newCommandTimeout': 300,
      'appium:adbExecTimeout': 60_000, // the 20s default is too short for slow phones and emulators
    },
  })
  return { driver, runId: lease.runId, appId: await driver.getCurrentPackage() }
}

// Every scenario starts from a fresh app: data cleared, app opened.
async function resetApp(session: Session) {
  await session.driver.execute('mobile: clearApp', { appId: session.appId })
  await session.driver.activateApp(session.appId)
}

async function closeSession(device: Device, session: Session | null) {
  await session?.driver
    .deleteSession()
    .catch((err) => log(device.name, 'could not close the Appium session', err))
}

// The scenario never ran (session or server problem): tell the server now instead of letting
// the lease run out. It counts as a failed attempt, so the retry can go to another phone.
async function reportRunnerError(device: Device, lease: Lease, err: unknown) {
  await sendResult({
    queueId: lease.queueId,
    device: device.name,
    status: 'failed',
    durationMs: 0,
    error: `runner error: ${err instanceof Error ? err.message : String(err)}`,
  }).catch((sendErr) => log(device.name, 'could not report the runner error', sendErr))
}
