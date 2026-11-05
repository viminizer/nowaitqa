// One worker per phone: take the next scenario, stop its executor, report it, repeat.

import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  type AttemptOrigin,
  DEVICE_CONTACT_INTERVAL_MS,
  type Device,
  every,
  type Lease,
  messageOf,
  type ResolvedInputs,
} from '@nowait/shared'
import { type Browser, remote } from 'webdriverio'
import { z } from 'zod'
import {
  contactDevice,
  DeviceGoneError,
  DevicePausedError,
  lease,
  ResultNotSentError,
  releaseLease,
  sendInputRuntime,
  sendResult,
  verifyInputs,
} from './api.ts'
import { type AppiumGate, openAppiumGate } from './appium-gate.ts'
import { pinCatalog, type ScenarioPin } from './catalog.ts'
import { config } from './config.ts'
import { type AttemptTrace, attemptTrace } from './diagnostics.ts'
import { cleanupFixture, FixtureCleanupUnconfirmedError } from './fixtures.ts'
import { scenarioIdentity, stageApp } from './input-files.ts'
import { inputRuntime } from './input-runtime.ts'
import { type LeaseGuard, watchLease } from './lease-guard.ts'
import { log } from './log.ts'
import { runScenario } from './scenario.ts'

type Session = {
  driver: Browser
  runId: number
  appId: string
  resetAt: number
  profile: string | null
}
const ERROR_PAUSE_MS = 60_000

export async function runWorker(device: Device, shutdown = new AbortController().signal) {
  log(device.name, 'worker started')
  const gate = await openAppiumGate(device)
  const stopContact = every(
    DEVICE_CONTACT_INTERVAL_MS,
    'runner contact',
    (signal) => contactDevice(device, signal),
    {
      error: (err, message) => log(device.name, message, err),
    },
  )
  let session: Session | null = null
  let sessionApp: Awaited<ReturnType<typeof stageApp>> | undefined
  const cleanupSession = async () => {
    const clean = await gate.cleanup()
    if (clean) {
      await sessionApp?.release()
      sessionApp = undefined
    }
    return clean
  }
  const acknowledge = async (current: Lease) => {
    try {
      return await releaseLease(current.queueId, device.name)
    } catch (err) {
      log(device.name, `cleanup acknowledgement for ${current.queueId} failed`, err)
      return false
    }
  }
  try {
    while (!shutdown.aborted) {
      let trace: AttemptTrace | undefined
      let current: Lease | null = null
      let guard: LeaseGuard | undefined
      let ownsEvidence = false
      let publishing = false
      let stopped = true
      let phase: AttemptOrigin['phase'] = 'setup'
      let scenario: ScenarioPin | undefined
      let prepared: Awaited<ReturnType<typeof stageApp>> | undefined
      let verifiedInputs: ResolvedInputs | undefined
      try {
        if (await cleanupFixture(device, shutdown)) continue
        const catalog = pinCatalog()
        try {
          if (!catalog.commits.length) {
            await pause(ERROR_PAUSE_MS, shutdown)
            continue
          }
          current = await lease(device.name, catalog.commits, session?.runId, shutdown)
          if (!current) continue
          trace = attemptTrace(device, current)
          gate.observe(trace.command)
          scenario = catalog.scenario(current.commit, current.scenarioId)
        } finally {
          catalog.release()
        }
        if (!current.cleanupRequired)
          throw new Error('upgrade the server: cleanup acknowledgement protocol is required')
        if (current.inputProtocol !== 1)
          throw new Error('upgrade the server: run input verification protocol is required')
        if (current.profile && current.profileProtocol !== 1)
          throw new Error('upgrade the server: required profile verification is unavailable')
        if (
          current.deviceIdentity &&
          Object.entries(current.deviceIdentity).some(
            ([key, value]) => device[key as keyof Device] !== value,
          )
        )
          throw new Error(
            'device registration changed; restart the runner to use its current identity',
          )
        guard = watchLease(device, current, shutdown)
        let headers = gate.activate(guard)
        await guard.renew()
        if (current.inputIntent) {
          const identity = await scenarioIdentity(
            dirname(scenario.file),
            current.commit,
            guard.signal,
          )
          prepared = await stageApp(current.appBuild, device, guard.signal)
          verifiedInputs = await verifyInputs(
            current.queueId,
            device.name,
            {
              app: prepared.identity,
              scenarios: identity,
              config: {
                sessionMode: config.SESSION_MODE,
                scenarioTimeoutSeconds: config.SCENARIO_TIMEOUT_SECONDS,
              },
            },
            guard.signal,
          )
        }
        if (
          config.SESSION_MODE === 'reuse' &&
          session?.runId === current.runId &&
          session.profile === (current.profile?.name ?? null) &&
          session.resetAt === current.sessionResetAt.getTime()
        ) {
          await prepared?.release()
          prepared = undefined
          ownsEvidence = true
          trace?.enter('session_reset')
          await resetApp(device, session)
        } else {
          phase = 'cleanup'
          trace?.enter('cleanup')
          if (!(await cleanupSession())) throw new Error('previous session cleanup not confirmed')
          session = null
          headers = gate.activate(guard)
          phase = 'setup'
          sessionApp = prepared
          prepared = undefined
          ownsEvidence = true
          trace?.enter('session_start')
          session = await openSession(
            device,
            sessionApp ? { ...current, appBuild: sessionApp.path } : current,
            gate,
          )
        }
        guard.check()
        if (current.inputIntent) {
          const runtime = await inputRuntime(device, session.driver, guard.signal)
          trace?.runtime(runtime)
          await sendInputRuntime(current.queueId, device.name, runtime, guard.signal)
        }
        // Staging and session startup can take minutes. A local edit during that interval
        // must fail before the executor imports source under the previously pinned identity.
        if (verifiedInputs)
          await verifyInputs(
            current.queueId,
            device.name,
            {
              ...verifiedInputs,
              scenarios: await scenarioIdentity(
                dirname(scenario.file),
                current.commit,
                guard.signal,
              ),
            },
            guard.signal,
          )
        if (!trace) throw new Error('attempt diagnostics were not initialized')
        trace.enter('executor_start')
        stopped = false // retain the checkout on an unexpected failure until exit is confirmed
        const execution = await runScenario(
          session.driver,
          device,
          current,
          guard,
          gate,
          headers,
          scenario.file,
          trace,
        )
        stopped = execution.stopped
        Object.assign(
          execution.result,
          await trace.capture(
            gate,
            stopped && !guard.signal.aborted,
            execution.result.status === 'failed',
          ),
        )
        trace.enter('cleanup')
        let clean = stopped
        if (
          config.SESSION_MODE === 'fresh' ||
          execution.result.status === 'failed' ||
          guard.signal.aborted ||
          gate.needsCleanup
        ) {
          clean = (await cleanupSession()) && stopped
          session = null
        }
        gate.stopCommands()
        guard.stop()
        // A cancelled/expired run can already have its outcome. Its separately retained
        // device/account reservation is released only after execution and cleanup are confirmed.
        const acknowledged = clean && (await acknowledge(current))
        publishing = true
        const saved = await sendResult({
          ...execution.result,
          cleanupComplete: clean,
          diagnostics: trace.finish(execution.result.error),
        })
        if (!saved)
          log(
            device.name,
            `result for ${current.scenarioId} was already finished or its lease is gone`,
          )
        if (!clean || (!acknowledged && !saved)) {
          log(
            device.name,
            `cleanup for attempt ${current.queueId} is not confirmed; worker stopped and resources remain reserved`,
          )
          return
        }
      } catch (err) {
        const interruption = guard?.signal.aborted
          ? guard.stopping
            ? 'cancelled'
            : 'lease_lost'
          : null
        const evidence =
          current && trace && !publishing
            ? await trace.capture(
                ownsEvidence ? gate : null,
                stopped && !!guard && !guard.signal.aborted,
                true,
              )
            : {}
        trace?.enter('cleanup')
        gate.stopCommands()
        const clean = (await cleanupSession()) && stopped
        guard?.stop()
        session = null
        if (current && clean) await acknowledge(current)
        if (current && !publishing)
          await reportRunnerError(
            device,
            current,
            err,
            clean,
            {
              phase,
              failureKind:
                interruption ??
                (phase === 'setup' && gate.sessionUnavailable ? 'session_unavailable' : 'unknown'),
            },
            { ...evidence, diagnostics: trace?.finish(messageOf(err)) },
          )
        if (!clean) {
          log(
            device.name,
            `cleanup for attempt ${current?.queueId} is not confirmed; resources remain reserved`,
            err,
          )
          return
        }
        if (shutdown.aborted || err instanceof FixtureCleanupUnconfirmedError) return
        if (err instanceof DevicePausedError) {
          log(device.name, err.message)
          await pause(Math.max(0, err.until - Date.now()), shutdown)
          continue
        }
        if (err instanceof DeviceGoneError) {
          log(device.name, 'worker stopped', err.message)
          return
        }
        // Never replace an outcome whose send might already have reached the server.
        if (err instanceof ResultNotSentError) {
          log(device.name, `${err.message}; unsaved work expires`)
          continue
        }
        log(device.name, 'worker error', err)
        if (current && !current.cleanupRequired) return
        await pause(ERROR_PAUSE_MS, shutdown)
      } finally {
        trace?.stop()
        gate.observe(undefined)
        guard?.stop()
        await prepared?.release()
        if (stopped) scenario?.release()
      }
    }
  } finally {
    stopContact()
    if (!(await cleanupSession()))
      log(device.name, 'worker stopped with unconfirmed session cleanup')
    await gate.close()
  }
}

async function pause(ms: number, signal: AbortSignal) {
  await sleep(ms, undefined, { signal }).catch((err) => {
    if (!signal.aborted) throw err
  })
}

async function openSession(device: Device, lease: Lease, gate: AppiumGate): Promise<Session> {
  const ios = device.platform === 'ios'
  const driver = await remote({
    ...gate.options,
    logLevel: 'warn',
    waitforTimeout: 15_000,
    // No automatic POST /session retry: a timed-out request may still create a session.
    connectionRetryTimeout: ios ? 600_000 : 120_000,
    connectionRetryCount: 0,
    capabilities: {
      'appium:udid': device.udid,
      'appium:app': lease.appBuild,
      'appium:newCommandTimeout': 300,
      ...(ios
        ? {
            platformName: 'iOS',
            'appium:automationName': 'XCUITest',
            'appium:wdaLocalPort': device.systemPort,
            'appium:wdaLaunchTimeout': 180_000,
            'appium:wdaStartupRetries': 1,
            'appium:mjpegServerPort': device.systemPort + 1,
            'appium:derivedDataPath': `/tmp/nowait-wda-${device.udid.toLowerCase()}`,
            'appium:screenshotQuality': 0,
          }
        : {
            platformName: 'Android',
            'appium:automationName': 'UiAutomator2',
            'appium:systemPort': device.systemPort,
            'appium:autoGrantPermissions': true,
            'appium:adbExecTimeout': 60_000,
          }),
    },
  })
  // The gate records the session before startup/reset can fail, and the parent cleans it
  // directly even when further ordinary commands are forbidden after lease loss.
  if (!ios) await hideErrorDialogs(device, driver)
  const appId = ios
    ? z.object({ bundleId: z.string().min(1) }).parse(await driver.execute('mobile: activeAppInfo'))
        .bundleId
    : await driver.getCurrentPackage()
  const session = {
    driver,
    runId: lease.runId,
    appId,
    resetAt: lease.sessionResetAt.getTime(),
    profile: lease.profile?.name ?? null,
  }
  if (ios || config.SESSION_MODE === 'fresh') await resetApp(device, session)
  return session
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

async function resetApp(device: Device, session: Session) {
  await session.driver.execute(
    'mobile: clearApp',
    device.platform === 'ios' ? { bundleId: session.appId } : { appId: session.appId },
  )
  await session.driver.activateApp(session.appId)
}

async function reportRunnerError(
  device: Device,
  lease: Lease,
  err: unknown,
  cleanupComplete: boolean,
  origin: Pick<AttemptOrigin, 'phase' | 'failureKind'>,
  evidence: Pick<import('@nowait/shared').ResultBody, 'screenshot' | 'log' | 'diagnostics'>,
) {
  await sendResult({
    queueId: lease.queueId,
    device: device.name,
    status: 'failed',
    durationMs: 0,
    error: `runner error: ${messageOf(err)}`,
    ...evidence,
    cleanupComplete,
    ...origin,
    scenarioStarted: false,
  }).catch((sendErr) => log(device.name, 'could not report the runner error', sendErr))
}
