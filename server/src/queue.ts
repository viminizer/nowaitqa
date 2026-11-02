// All queue logic lives here (R6): creating runs, leasing, heartbeats, results, expiry and retries.

import { loadScenarios } from '@nowait/scenarios'
import type { CreateRunBody, Lease, ResultBody, RunSummary } from '@nowait/shared'
import { and, asc, eq, lt, sql } from 'drizzle-orm'
import { saveArtifact } from './artifacts.ts'
import { config } from './config.ts'
import { db } from './db/index.ts'
import { accounts, devices, queue, results, runs } from './db/schema.ts'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type QueueRow = typeof queue.$inferSelect

// --- waking long-polling workers -------------------------------------------------------------
// ponytail: in-memory signal, works for one server process. Use Postgres LISTEN/NOTIFY if we
// ever run several.

let waiters: (() => void)[] = []

function notifyWork() {
  const woken = waiters
  waiters = []
  for (const wake of woken) wake()
}

export function waitForWork(ms: number) {
  return new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer)
      waiters = waiters.filter((w) => w !== wake)
      resolve()
    }
    const timer = setTimeout(wake, ms)
    waiters.push(wake)
  })
}

// --- runs ------------------------------------------------------------------------------------

export async function createRun(body: CreateRunBody) {
  const scenarioIds = (await loadScenarios())
    .filter((s) => s.platforms.includes(body.platform))
    .map((s) => s.id)
  if (scenarioIds.length === 0) return null

  const runId = await db.transaction(async (tx) => {
    const [run] = await tx.insert(runs).values(body).returning({ id: runs.id })
    if (!run) throw new Error('run insert returned nothing')
    await tx.insert(queue).values(scenarioIds.map((scenarioId) => ({ runId: run.id, scenarioId })))
    return run.id
  })
  notifyWork()
  return runId
}

export async function getRun(id: number): Promise<RunSummary | null> {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, id) })
  if (!run) return null

  const attempts = await db
    .select({ scenarioId: queue.scenarioId, attempt: queue.attempt, result: results.status })
    .from(queue)
    .leftJoin(results, eq(results.queueId, queue.id))
    .where(eq(queue.runId, id))
    .orderBy(asc(queue.id))

  const byScenario = new Map<string, RunSummary['scenarios'][number]['status']>()
  for (const a of attempts) {
    const status =
      a.result === 'passed'
        ? a.attempt === 1
          ? 'passed'
          : 'flaky'
        : a.result === 'failed' && a.attempt >= config.MAX_ATTEMPTS
          ? 'failed'
          : 'pending'
    // attempts are in order, so the latest attempt decides
    byScenario.set(a.scenarioId, status)
  }

  return {
    ...run,
    scenarios: [...byScenario].map(([scenarioId, status]) => ({ id: scenarioId, status })),
  }
}

// --- leasing ---------------------------------------------------------------------------------

export class UnknownDeviceError extends Error {}

export async function leaseNext(deviceName: string): Promise<Lease | null> {
  return db.transaction(async (tx) => {
    const device = await tx.query.devices.findFirst({
      where: and(eq(devices.name, deviceName), eq(devices.enabled, true)),
    })
    if (!device) throw new UnknownDeviceError(`unknown or disabled device: ${deviceName}`)

    // Oldest run first. SKIP LOCKED: if another phone is taking a row right now, take the next one.
    const [row] = await tx
      .select({ id: queue.id, run: runs })
      .from(queue)
      .innerJoin(runs, eq(runs.id, queue.runId))
      .where(and(eq(queue.status, 'pending'), eq(runs.platform, device.platform)))
      .orderBy(asc(queue.runId), asc(queue.id))
      .limit(1)
      .for('update', { of: queue, skipLocked: true })
    if (!row) return null

    const account = await takeAccount(tx, row.id)
    if (account === false) return null // the pool has accounts, but all are busy

    const [leased] = await tx
      .update(queue)
      .set({
        status: 'leased',
        device: device.name,
        leaseUntil: sql`now() + make_interval(secs => ${config.LEASE_SECONDS})`,
      })
      .where(eq(queue.id, row.id))
      .returning()
    if (!leased) throw new Error('lease update returned nothing')

    return {
      queueId: leased.id,
      runId: row.run.id,
      appBuild: row.run.appBuild,
      commit: row.run.commit,
      scenarioId: leased.scenarioId,
      attempt: leased.attempt,
      account,
      leaseSeconds: config.LEASE_SECONDS,
    }
  })
}

// Returns a free account's username, null when the pool is empty (the app needs no login),
// or false when every account is busy. An account is free when its queue row is not leased.
async function takeAccount(tx: Tx, queueId: number): Promise<string | null | false> {
  const free = await tx.execute<{ username: string }>(sql`
    SELECT a.username FROM ${accounts} a
    WHERE a.queue_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM ${queue} q WHERE q.id = a.queue_id AND q.status = 'leased')
    LIMIT 1 FOR UPDATE SKIP LOCKED`)
  const username = free.rows[0]?.username
  if (!username) {
    const any = await tx.select({ username: accounts.username }).from(accounts).limit(1)
    return any.length === 0 ? null : false
  }
  await tx.update(accounts).set({ queueId }).where(eq(accounts.username, username))
  return username
}

export async function heartbeat(queueId: number, device: string) {
  const updated = await db
    .update(queue)
    .set({ leaseUntil: sql`now() + make_interval(secs => ${config.LEASE_SECONDS})` })
    .where(and(eq(queue.id, queueId), eq(queue.device, device), eq(queue.status, 'leased')))
    .returning({ id: queue.id })
  return updated.length > 0
}

// --- finishing attempts ----------------------------------------------------------------------

// Returns false when the lease is no longer this device's (it expired and the scenario moved on).
export async function submitResult(body: ResultBody) {
  const retried = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(queue)
      .set({ status: 'done' })
      .where(
        and(eq(queue.id, body.queueId), eq(queue.device, body.device), eq(queue.status, 'leased')),
      )
      .returning()
    if (!row) return null

    const name = `${row.scenarioId}-${row.attempt}`
    return recordAttempt(tx, row, {
      status: body.status,
      durationMs: body.durationMs,
      error: body.error,
      screenshot:
        body.screenshot &&
        (await saveArtifact(row.runId, `${name}.png`, Buffer.from(body.screenshot, 'base64'))),
      log: body.log && (await saveArtifact(row.runId, `${name}.log`, body.log)),
    })
  })
  if (retried === null) return false
  if (retried) notifyWork()
  return true
}

// A lease that ran out means the worker died: count it as a failed attempt.
export async function expireLeases() {
  const retried = await db.transaction(async (tx) => {
    const expired = await tx
      .update(queue)
      .set({ status: 'done' })
      .where(and(eq(queue.status, 'leased'), lt(queue.leaseUntil, sql`now()`)))
      .returning()
    let anyRetried = false
    for (const row of expired) {
      const error = `lease expired: lost contact with device ${row.device}`
      anyRetried =
        (await recordAttempt(tx, row, { status: 'failed', durationMs: 0, error })) || anyRetried
    }
    return anyRetried
  })
  if (retried) notifyWork()
}

type Outcome = Pick<ResultBody, 'status' | 'durationMs' | 'error'> & {
  screenshot?: string
  log?: string
}

// Saves the result of a finished attempt, queues a retry if allowed, and closes the run when
// nothing is left. Returns true when a retry was queued.
async function recordAttempt(tx: Tx, row: QueueRow, outcome: Outcome) {
  await tx.insert(results).values({
    queueId: row.id,
    runId: row.runId,
    scenarioId: row.scenarioId,
    attempt: row.attempt,
    device: row.device,
    ...outcome,
  })

  if (outcome.status === 'failed' && row.attempt < config.MAX_ATTEMPTS) {
    await tx
      .insert(queue)
      .values({ runId: row.runId, scenarioId: row.scenarioId, attempt: row.attempt + 1 })
    return true
  }

  await finishRunIfDone(tx, row.runId)
  return false
}

async function finishRunIfDone(tx: Tx, runId: number) {
  // Lock the run first, so two attempts finishing at the same moment cannot both miss the end.
  await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).for('update')

  const open = await tx.execute(
    sql`SELECT 1 FROM ${queue} WHERE run_id = ${runId} AND status <> 'done' LIMIT 1`,
  )
  if (open.rows.length > 0) return

  const failed = await tx.execute(sql`
    SELECT 1 FROM ${queue} q
    WHERE q.run_id = ${runId}
      AND NOT EXISTS (
        SELECT 1 FROM ${results} r
        WHERE r.run_id = ${runId} AND r.scenario_id = q.scenario_id AND r.status = 'passed')
    LIMIT 1`)
  await tx
    .update(runs)
    .set({ status: failed.rows.length > 0 ? 'failed' : 'passed', finishedAt: sql`now()` })
    .where(eq(runs.id, runId))
}
