// Isolate scenario code from the heartbeat/event loop and confirm exit before returning a result.
import { type ChildProcess, fork } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { Device, Lease, ResultBody } from '@nowait/shared'
import type { Browser } from 'webdriverio'
import type { AppiumGate } from './appium-gate.ts'
import { findScenarioFile } from './catalog.ts'
import { config } from './config.ts'
import { log } from './log.ts'
import { ScenarioOutcome, ScenarioReady } from './scenario-protocol.ts'

const STOP_GRACE_MS = 250
const STOP_LIMIT_MS = 5_000
const EVIDENCE_LIMIT_MS = 15_000

async function stopExecutor(child: ChildProcess, exited: Promise<void>, device: string) {
  if (!child.pid) return true
  const pid = child.pid
  const groupSignal = (signal: NodeJS.Signals | 0) => {
    try {
      process.kill(-pid, signal)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false
      throw err
    }
  }
  if (child.connected)
    child.send({ type: 'stop' }, (err) => {
      if (err) log(device, 'could not signal scenario stop', err.message)
    })
  const kill = setTimeout(() => {
    try {
      groupSignal('SIGKILL')
    } catch (err) {
      log(device, 'could not terminate scenario process group', err)
    }
  }, STOP_GRACE_MS)
  let limit: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      exited
        .then(async () => {
          // The executor can have exited with an ordinary child tool still running. Its owned
          // process group must be gone too before the device/account can be released.
          groupSignal('SIGKILL')
          const deadline = performance.now() + STOP_LIMIT_MS
          while (groupSignal(0)) {
            if (performance.now() >= deadline) return false
            await sleep(20)
          }
          return true
        })
        .catch((err) => {
          log(device, 'scenario process group cleanup failed', err)
          return false
        }),
      new Promise<false>((resolve) => {
        limit = setTimeout(() => resolve(false), STOP_LIMIT_MS)
      }),
    ])
  } finally {
    clearTimeout(kill)
    clearTimeout(limit)
  }
}

export async function runScenario(
  driver: Browser,
  device: Device,
  lease: Lease,
  signal: AbortSignal,
  gate: AppiumGate,
  headers: Record<string, string>,
) {
  const started = performance.now()
  let child: ChildProcess | undefined
  let exited = Promise.resolve()
  let outcome: ScenarioOutcome
  try {
    signal.throwIfAborted()
    const file = findScenarioFile(lease.commit, lease.scenarioId)
    if (!file)
      throw new Error(
        `scenario ${lease.scenarioId} at commit ${lease.commit} is not on this runner`,
      )
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
      const finish = (result: ScenarioOutcome) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        gate.stopScenario()
        resolve(result)
      }
      const abort = () => finish({ status: 'failed', error: String(signal.reason) })
      let timer = setTimeout(
        () => finish({ status: 'failed', error: 'scenario executor startup timed out after 30s' }),
        30_000,
      )
      let ready = false
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      executor.on('message', (message) => {
        if (finished) return
        if (ScenarioReady.safeParse(message).success) {
          if (ready) return finish({ status: 'failed', error: 'duplicate scenario readiness' })
          ready = true
          clearTimeout(timer)
          timer = setTimeout(
            () =>
              finish({
                status: 'failed',
                error: `timed out after ${config.SCENARIO_TIMEOUT_SECONDS}s`,
              }),
            config.SCENARIO_TIMEOUT_SECONDS * 1000,
          )
          start()
          return
        }
        const parsed = ScenarioOutcome.safeParse(message)
        finish(
          parsed.success ? parsed.data : { status: 'failed', error: 'invalid scenario outcome' },
        )
      })
      executor.once('error', (err) =>
        finish({ status: 'failed', error: `scenario process error: ${err.message}` }),
      )
      executor.once('close', (code, killed) =>
        finish({
          status: 'failed',
          error: `scenario process exited without a result (${killed ?? code})`,
        }),
      )
      const start = () =>
        executor.send(
          {
            type: 'start',
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
            if (err) finish({ status: 'failed', error: `could not start scenario: ${err.message}` })
          },
        )
    })
  } catch (err) {
    outcome = {
      status: 'failed',
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    }
  }
  gate.stopScenario()
  const stopped = !child || (await stopExecutor(child, exited, device.name))
  const result: ResultBody = {
    queueId: lease.queueId,
    device: device.name,
    ...outcome,
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
  } else if (outcome.status === 'failed' && !signal.aborted) {
    log(device.name, `${lease.scenarioId} failed`, outcome.error)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      Object.assign(
        result,
        await Promise.race([
          capture(driver, device).catch((err) => ({
            log: `failure evidence could not be collected: ${String(err)}`,
          })),
          new Promise((resolve) => {
            timer = setTimeout(() => {
              gate.stopCommands()
              resolve({ log: 'failure evidence timed out' })
            }, EVIDENCE_LIMIT_MS)
          }),
        ]),
      )
    } finally {
      clearTimeout(timer)
    }
  }
  return { result, stopped }
}

async function capture(driver: Browser, device: Device) {
  const notes: string[] = []
  const screenshot = await driver.takeScreenshot().catch((err) => {
    notes.push(`screenshot failed: ${err}`)
    return undefined
  })
  const lines = await driver
    .getLogs(device.platform === 'android' ? 'logcat' : 'syslog')
    .catch((err) => {
      notes.push(`device log failed: ${err}`)
      return []
    })
  const deviceLog = (lines as { timestamp: number; message: string }[])
    .slice(-500)
    .map((l) => `${new Date(l.timestamp).toISOString()} ${l.message}`)
  return { screenshot, log: [...notes, ...deviceLog].join('\n') }
}
