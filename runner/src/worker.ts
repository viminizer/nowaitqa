// One worker per phone: take the next scenario, run it, report it, repeat.

import { setTimeout as sleep } from 'node:timers/promises'
import { type Device, type Lease, messageOf } from '@nowait/shared'
import { type Browser, remote } from 'webdriverio'
import { z } from 'zod'
import { DeviceGoneError, heartbeat, lease, ResultNotSentError, sendResult } from './api.ts'
import { commits } from './catalog.ts'
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
    let leaseGone = false
    let stopHeartbeat = () => {}
    try {
      current = await lease(device.name, commits(), session?.runId)
      if (!current) continue
      // From the moment we hold the lease: a first app install can take minutes.
      // If the lease is gone, ending the Appium session stops the scenario at its next command.
      stopHeartbeat = keepLeaseAlive(device, current, async () => {
        leaseGone = true
        await closeSession(device, session)
      })

      // One session per phone for the whole run. A new run brings a new app build.
      if (session?.runId === current.runId) {
        await resetApp(device, session)
      } else {
        await closeSession(device, session)
        session = null
        session = await openSession(device, current)
      }

      // Cancellation may arrive while Xcode is still creating the session. The heartbeat had
      // no session to close yet; release it as soon as creation finishes, without running code.
      if (leaseGone) {
        await closeSession(device, session)
        session = null
        continue
      }

      const result = await runScenario(session.driver, device, current)
      stopHeartbeat()
      const saved = await sendResult(result)
      if (!saved) {
        const why = 'the lease was gone, or an earlier try already saved it'
        log(device.name, `result for ${current.scenarioId} not recorded by this send: ${why}`)
      }

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
      // A result that could not be sent is not replaced by a "runner error" result: one of its
      // tries may still be saved by the server, and the error report would win over it. Its lease
      // runs out instead: "lease expired", and the scenario runs again if it has attempts left
      // (on its last attempt it stays failed). The phone itself is fine, so no pause.
      if (err instanceof ResultNotSentError) {
        log(device.name, `${err.message}; unless a try got through, it counts as "lease expired"`)
        continue
      }
      log(device.name, 'worker error', err)
      if (current) await reportRunnerError(device, current, err)
      await sleep(ERROR_PAUSE_MS)
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
  const ios = device.platform === 'ios'
  const url = new URL(device.appiumUrl)
  const driver = await remote({
    protocol: url.protocol.replace(':', ''),
    hostname: url.hostname,
    port: Number(url.port),
    path: url.pathname,
    logLevel: 'warn',
    waitforTimeout: 15_000, // how long waitForDisplayed and friends wait; phones can be slow
    // A cold WDA build/boot takes longer than WebdriverIO's default 120s. Heartbeats continue
    // throughout startup. Do not retry a timed-out POST /session: it may still create a session.
    ...(ios ? { connectionRetryTimeout: 600_000, connectionRetryCount: 0 } : {}),
    capabilities: {
      'appium:udid': device.udid,
      'appium:app': lease.appBuild,
      'appium:newCommandTimeout': 300,
      ...(ios
        ? {
            platformName: 'iOS',
            'appium:automationName': 'XCUITest',
            'appium:wdaLocalPort': device.systemPort,
            'appium:wdaLaunchTimeout': 180_000, // a cold Xcode build can exceed the default 60s
            'appium:wdaStartupRetries': 1,
            'appium:mjpegServerPort': device.systemPort + 1,
            'appium:derivedDataPath': `/tmp/nowait-wda-${device.udid.toLowerCase()}`,
            'appium:screenshotQuality': 0, // artifacts are PNGs, including on iOS
          }
        : {
            platformName: 'Android',
            'appium:automationName': 'UiAutomator2',
            'appium:systemPort': device.systemPort,
            'appium:autoGrantPermissions': true,
            'appium:adbExecTimeout': 60_000, // the default 20s is too short for slow phones
          }),
    },
  })
  // From here on the session exists: close it if the rest fails, or it holds the phone's port
  // until Appium's newCommandTimeout.
  try {
    if (!ios) await hideErrorDialogs(device, driver)
    const appId = ios
      ? z
          .object({ bundleId: z.string().min(1) })
          .parse(await driver.execute('mobile: activeAppInfo')).bundleId
      : await driver.getCurrentPackage()
    const session = { driver, runId: lease.runId, appId }
    // Also clear an app left on the device by a previous run or failed attempt.
    if (ios) await resetApp(device, session)
    return session
  } catch (err) {
    await driver
      .deleteSession()
      .catch((e) => log(device.name, 'could not close the Appium session', e))
    throw err
  }
}

// When an app hangs, Android shows "<app> isn't responding" over every app, and every scenario on
// the phone fails under it (seen: "System UI isn't responding" on a slow emulator). With this
// setting Android shows no dialog and closes the hung app: System UI restarts, and an app under
// test that hangs still fails its scenario. Appium allows it only when started with
// --allow-insecure=uiautomator2:adb_shell; without that the phone works as before (R50).
// The setting stays on the phone, so it is tried once per phone while the runner runs, and a
// failure is logged once (R49). ponytail: a phone whose try failed is tried again only after a
// runner restart.
const dialogsTried = new Set<string>()

async function hideErrorDialogs(device: Device, driver: Browser) {
  if (dialogsTried.has(device.name)) return
  dialogsTried.add(device.name)
  await driver
    .execute('mobile: shell', {
      command: 'settings',
      args: ['put', 'global', 'hide_error_dialogs', '1'],
    })
    .catch((err) =>
      log(
        device.name,
        'could not hide "isn\'t responding" dialogs (is Appium started with --allow-insecure=uiautomator2:adb_shell?)',
        err,
      ),
    )
}

// Every scenario starts from a fresh app: data cleared, app opened.
async function resetApp(device: Device, session: Session) {
  await session.driver.execute(
    'mobile: clearApp',
    device.platform === 'ios' ? { bundleId: session.appId } : { appId: session.appId },
  )
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
    error: `runner error: ${messageOf(err)}`,
  }).catch((sendErr) => log(device.name, 'could not report the runner error', sendErr))
}
