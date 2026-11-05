// Isolate scenario code from the heartbeat/event loop and confirm exit before returning a result.
import { type ChildProcess, fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Device, FailureKind, Lease, ResultBody } from '@nowait/shared'
import type { Browser } from 'webdriverio'
import { registerFixture } from './api.ts'
import type { AppiumGate } from './appium-gate.ts'
import { config, fixtureTimeoutMs } from './config.ts'
import type { AttemptTrace } from './diagnostics.ts'
import { stopExecutor } from './executor.ts'
import type { LeaseGuard } from './lease-guard.ts'
import { log } from './log.ts'
import {
  FixtureRequest,
  FixtureSetupDone,
  ScenarioOutcome,
  ScenarioReady,
  ScenarioStarted,
} from './scenario-protocol.ts'

export async function runScenario(
  driver: Browser,
  device: Device,
  lease: Lease,
  guard: LeaseGuard,
  gate: AppiumGate,
  headers: Record<string, string>,
  file: string,
  trace: AttemptTrace,
) {
  const started = performance.now()
  const signal = guard.signal
  let scenarioStarted: boolean | null = false
  const failure = (error: string, failureKind: FailureKind = 'unknown'): ScenarioOutcome => ({
    status: 'failed',
    error,
    failureKind,
    scenarioStarted,
    phase: scenarioStarted === null ? 'unknown' : scenarioStarted ? 'scenario' : 'setup',
  })
  let child: ChildProcess | undefined
  let exited = Promise.resolve()
  let outcome: ScenarioOutcome
  try {
    signal.throwIfAborted()
    if (lease.account && !config.TEST_ACCOUNT_PASSWORD)
      throw new Error('TEST_ACCOUNT_PASSWORD is not set')
    log(device.name, `run ${lease.runId}: ${lease.scenarioId} (attempt ${lease.attempt})`)
    child = fork(
      fileURLToPath(new URL('./scenario-process.ts', import.meta.url)),
      [String(lease.queueId), device.name],
      {
        detached: true,
        serialization: 'advanced',
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      },
    )
    log(device.name, `executor process group ${child.pid} for attempt ${lease.queueId}`)
    const executor = child
    exited = new Promise<void>((resolve) => executor.once('exit', () => resolve()))
    outcome = await new Promise<ScenarioOutcome>((resolve) => {
      let finished = false
      const fixtureTimers = new Map<number, ReturnType<typeof setTimeout>>()
      const finish = (result: ScenarioOutcome) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        for (const fixtureTimer of fixtureTimers.values()) clearTimeout(fixtureTimer)
        signal.removeEventListener('abort', abort)
        gate.stopScenario()
        resolve(result)
      }
      const abort = () =>
        finish(failure(String(signal.reason), guard.stopping ? 'cancelled' : 'lease_lost'))
      let timer = setTimeout(
        () => finish(failure('scenario executor startup timed out after 30s', 'executor_error')),
        30_000,
      )
      let ready = false
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      executor.on('message', (message) => {
        if (finished) return
        const settled = FixtureSetupDone.safeParse(message)
        if (settled.success) {
          clearTimeout(fixtureTimers.get(settled.data.requestId))
          fixtureTimers.delete(settled.data.requestId)
          return
        }
        const fixture = FixtureRequest.safeParse(message)
        if (fixture.success) {
          const request = fixture.data
          if (fixtureTimers.has(request.requestId))
            return finish(failure('duplicate fixture setup request', 'executor_error'))
          // The disposable executor may block its own event loop. Enforce setup's bound here,
          // including registration latency, independently of the longer scenario deadline.
          fixtureTimers.set(
            request.requestId,
            setTimeout(
              () => finish(failure('fixture setup timed out', 'timeout')),
              fixtureTimeoutMs(config.SCENARIO_TIMEOUT_SECONDS),
            ),
          )
          void (async () => {
            try {
              if (lease.fixtureProtocol !== 1)
                throw new Error('upgrade the server before using fixtures')
              guard.check()
              const record = await registerFixture(
                { queueId: lease.queueId, device: device.name, name: request.name },
                signal,
              )
              guard.check()
              if (!finished && executor.connected)
                executor.send(
                  { type: 'fixture_registered', requestId: request.requestId, key: record.key },
                  (err) => {
                    if (err) log(device.name, 'fixture registration reply unavailable', err.name)
                  },
                )
            } catch (err) {
              log(
                device.name,
                'fixture registration unavailable',
                err instanceof Error ? err.name : 'unknown error',
              )
              if (!finished && executor.connected)
                executor.send(
                  {
                    type: 'fixture_error',
                    requestId: request.requestId,
                    upgradeRequired: lease.fixtureProtocol !== 1,
                  },
                  (sendErr) => {
                    if (sendErr)
                      log(device.name, 'fixture rejection reply unavailable', sendErr.name)
                  },
                )
            }
          })()
          return
        }
        if (ScenarioStarted.safeParse(message).success) {
          scenarioStarted = true
          guard.markStarted()
          trace.enter('scenario')
          return
        }
        if (ScenarioReady.safeParse(message).success) {
          if (ready) return finish(failure('duplicate scenario readiness', 'executor_error'))
          ready = true
          clearTimeout(timer)
          timer = setTimeout(
            () => finish(failure(`timed out after ${config.SCENARIO_TIMEOUT_SECONDS}s`, 'timeout')),
            config.SCENARIO_TIMEOUT_SECONDS * 1000,
          )
          start()
          return
        }
        const parsed = ScenarioOutcome.safeParse(message)
        finish(parsed.success ? parsed.data : failure('invalid scenario outcome', 'executor_error'))
      })
      executor.once('error', (err) =>
        finish(failure(`scenario process error: ${err.message}`, 'executor_error')),
      )
      executor.once('close', (code, killed) =>
        finish(
          failure(`scenario process exited without a result (${killed ?? code})`, 'executor_error'),
        ),
      )
      const start = () => {
        scenarioStarted = null // dispatch is not proof that the scenario body began
        executor.send(
          {
            type: 'start',
            queueId: lease.queueId,
            fixtureTimeoutMs: fixtureTimeoutMs(config.SCENARIO_TIMEOUT_SECONDS),
            file,
            scenarioId: lease.scenarioId,
            sessionId: driver.sessionId,
            port: gate.options.port,
            headers,
            capabilities: driver.capabilities,
            account: lease.account
              ? { username: lease.account, password: config.TEST_ACCOUNT_PASSWORD }
              : null,
          },
          (err) => {
            if (err) finish(failure(`could not start scenario: ${err.message}`, 'executor_error'))
          },
        )
      }
    })
  } catch (err) {
    outcome = failure(err instanceof Error ? (err.stack ?? err.message) : String(err))
  }
  gate.stopScenario()
  const stopped = !child || (await stopExecutor(child, exited, device.name))
  const result: ResultBody = {
    queueId: lease.queueId,
    device: device.name,
    ...outcome,
    scenarioStarted: outcome.scenarioStarted ?? undefined,
    durationMs: Math.round(performance.now() - started),
  }
  if (!stopped) {
    result.error = [
      result.error,
      'scenario process termination not confirmed; resources remain reserved',
    ]
      .filter(Boolean)
      .join('\n')
    log(device.name, result.error)
  }
  return { result, stopped }
}
