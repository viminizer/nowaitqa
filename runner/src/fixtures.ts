import { type ChildProcess, fork } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Device,
  FIXTURE_CLAIM_SECONDS,
  type FixtureReason,
  ResolvedInputs,
} from '@nowait/shared'
import { claimFixture, finishFixture } from './api.ts'
import { pinCatalog, type ScenarioPin } from './catalog.ts'
import { config, fixtureTimeoutMs } from './config.ts'
import { stopExecutor } from './executor.ts'
import { scenarioIdentity } from './input-files.ts'
import { log } from './log.ts'
import { FixtureCleanupOutcome, ScenarioReady } from './scenario-protocol.ts'

export class FixtureCleanupUnconfirmedError extends Error {}

// One bounded job per worker iteration. The server keeps unverified resources/accounts and a
// device hold if this parent dies; a TTL alone never releases either reservation.
export async function cleanupFixture(device: Device, shutdown: AbortSignal) {
  const startedAt = performance.now()
  const job = await claimFixture(device, shutdown)
  if (!job) return false
  // Count request latency and source preparation against authority. Leave 20s for the 5s
  // process stop and 10s finish request; expiration itself never releases the server hold.
  const deadline = startedAt + FIXTURE_CLAIM_SECONDS * 1000 - 20_000
  const controller = new AbortController()
  const signal = AbortSignal.any([shutdown, controller.signal])
  const check = () => {
    if (performance.now() >= deadline)
      controller.abort(new Error('fixture cleanup authority elapsed'))
    signal.throwIfAborted()
  }
  const authorityTimer = setTimeout(
    () => controller.abort(new Error('fixture cleanup authority elapsed')),
    Math.max(0, deadline - performance.now()),
  )
  let pin: ScenarioPin | undefined
  let child: ChildProcess | undefined
  let exited = Promise.resolve()
  let clean = false
  let stopped = true
  let reason: FixtureReason = 'adapter_unavailable'
  try {
    check()
    const catalog = pinCatalog()
    try {
      pin = catalog.scenario(job.commit, job.scenarioId)
    } finally {
      catalog.release()
    }
    const observed = ResolvedInputs.shape.scenarios.parse(
      await scenarioIdentity(dirname(pin.file), job.commit, signal),
    )
    if (JSON.stringify(observed) !== JSON.stringify(job.scenarios))
      throw new Error('fixture cleanup source identity changed')
    if (job.account && !config.TEST_ACCOUNT_PASSWORD)
      throw new Error('cleanup account credential is unavailable')
    check()
    child = fork(fileURLToPath(new URL('./fixture-process.ts', import.meta.url)), [], {
      detached: true,
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    stopped = false
    log(device.name, `fixture cleanup process group ${child.pid} for resource ${job.id}`)
    const executor = child
    exited = new Promise<void>((resolve) => executor.once('exit', () => resolve()))
    reason = 'cleanup_failed'
    clean = await new Promise<boolean>((resolve) => {
      let finished = false
      const finish = (result: boolean) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        resolve(result)
      }
      const abort = () => finish(false)
      const timer = setTimeout(
        () => finish(false),
        fixtureTimeoutMs(job.config.scenarioTimeoutSeconds),
      )
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) return abort()
      let dispatched = false
      executor.on('message', (message) => {
        if (finished) return
        if (ScenarioReady.safeParse(message).success) {
          if (dispatched) return finish(false)
          try {
            check()
          } catch {
            return finish(false)
          }
          dispatched = true
          executor.send(
            {
              file: pin?.file,
              queueId: job.queueId,
              scenarioId: job.scenarioId,
              name: job.name,
              key: job.key,
              account: job.account
                ? { username: job.account, password: config.TEST_ACCOUNT_PASSWORD }
                : null,
            },
            (err) => {
              if (err) finish(false)
            },
          )
          return
        }
        finish(FixtureCleanupOutcome.safeParse(message).data?.clean === true)
      })
      executor.once('error', () => finish(false))
      executor.once('close', () => finish(false))
    })
  } catch (err) {
    log(
      device.name,
      `fixture ${job.id} cleanup unavailable`,
      err instanceof Error ? err.name : 'unknown error',
    )
  } finally {
    stopped = !child || (await stopExecutor(child, exited, device.name))
    clearTimeout(authorityTimer)
    if (stopped) pin?.release()
  }
  const saved = await finishFixture({
    id: job.id,
    claim: job.claim,
    device: device.name,
    clean: clean && stopped,
    stopped,
    reason,
  })
  if (!stopped || !saved)
    throw new FixtureCleanupUnconfirmedError(
      `fixture ${job.id} cleanup is unconfirmed; resources remain reserved`,
    )
  if (!clean)
    log(device.name, `fixture ${job.id} cleanup not verified; account remains quarantined`)
  return true
}
