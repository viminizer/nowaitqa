// All queue logic lives here (R6): creating runs, leasing, heartbeats, results, expiry and retries.

import {
  type Attempt,
  type AttemptPage,
  type Catalog,
  type CreateRunBody,
  countStatuses,
  type Lease,
  type ResultBody,
  type RunDetail,
  type RunList,
  type ScenarioStatus,
} from '@nowait/shared'
import { and, asc, desc, eq, inArray, isNull, like, lt, ne, or, sql } from 'drizzle-orm'
import { saveArtifact } from './artifacts.ts'
import { config } from './config.ts'
import { db } from './db/index.ts'
import { accounts, catalogs, devices, queue, results, runs } from './db/schema.ts'

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

export async function saveCatalog(catalog: Catalog) {
  await db
    .insert(catalogs)
    .values(catalog)
    .onConflictDoUpdate({
      target: catalogs.commit,
      set: { scenarios: catalog.scenarios, updatedAt: sql`now()` },
    })
}

export class BadRunError extends Error {}

export async function createRun(body: CreateRunBody) {
  // The run's commit (a short one works, like git), or the newest catalog a runner sent.
  const [catalog] = await db
    .select()
    .from(catalogs)
    .where(body.commit ? like(catalogs.commit, `${body.commit}%`) : undefined)
    .orderBy(desc(catalogs.updatedAt))
    .limit(1)
  if (!catalog) {
    throw new BadRunError(
      body.commit
        ? `no runner has sent its scenarios for commit ${body.commit}`
        : 'no runner has sent its scenarios yet',
    )
  }
  const scenarioIds = catalog.scenarios
    .filter((s) => s.platforms.includes(body.platform))
    .map((s) => s.id)
  if (scenarioIds.length === 0) {
    throw new BadRunError(`no ${body.platform} scenarios at commit ${catalog.commit}`)
  }
  const items = Array.from({ length: body.repeat }, () => scenarioIds).flat()

  // fixed: deal the items out to the phones up front, round robin, like the old framework.
  const phones =
    body.split === 'fixed'
      ? (
          await db
            .select({ name: devices.name })
            .from(devices)
            .where(and(eq(devices.platform, body.platform), eq(devices.enabled, true)))
            .orderBy(asc(devices.name))
        ).map((d) => d.name)
      : []
  if (body.split === 'fixed' && phones.length === 0) {
    throw new BadRunError(`no enabled ${body.platform} phones to split the run across`)
  }

  const runId = await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(runs)
      .values({ ...body, commit: catalog.commit })
      .returning({ id: runs.id })
    if (!run) throw new Error('run insert returned nothing')
    await tx.insert(queue).values(
      items.map((scenarioId, slot) => ({
        runId: run.id,
        slot,
        scenarioId,
        assignedDevice: phones[slot % phones.length],
      })),
    )
    return run.id
  })
  notifyWork()
  return runId
}

type Run = typeof runs.$inferSelect

// A scenario's final status, from its latest attempt.
function scenarioStatus(
  run: Run,
  attempt: number,
  result: 'passed' | 'failed' | null,
): ScenarioStatus {
  if (result === 'passed') return attempt === 1 ? 'passed' : 'flaky'
  // a finished run has no retry coming (it may have been stuck before one)
  if (result === 'failed' && (attempt >= config.MAX_ATTEMPTS || run.status !== 'running')) {
    return 'failed'
  }
  return 'pending'
}

const runDuration = (run: Run) =>
  run.finishedAt && run.finishedAt.getTime() - run.createdAt.getTime()

const RUNS_PAGE = 50

// The dashboard's runs list: RUNS_PAGE runs older than `before`, newest first (R24).
export async function listRuns(before?: number): Promise<RunList> {
  const page = await db
    .select()
    .from(runs)
    .where(before ? lt(runs.id, before) : undefined)
    .orderBy(desc(runs.id))
    .limit(RUNS_PAGE)
  if (page.length === 0) return { runs: [], older: null }

  // the latest attempt of every scenario in these runs
  const latest = await db
    .selectDistinctOn([queue.runId, queue.slot], {
      runId: queue.runId,
      attempt: queue.attempt,
      result: results.status,
    })
    .from(queue)
    .leftJoin(results, eq(results.queueId, queue.id))
    .where(
      inArray(
        queue.runId,
        page.map((r) => r.id),
      ),
    )
    .orderBy(queue.runId, queue.slot, desc(queue.attempt))

  const byRun = Map.groupBy(latest, (a) => a.runId)
  return {
    older: page.length === RUNS_PAGE ? (page.at(-1)?.id ?? null) : null,
    runs: page.map((run) => ({
      ...run,
      durationMs: runDuration(run),
      counts: countStatuses(
        (byRun.get(run.id) ?? []).map((a) => scenarioStatus(run, a.attempt, a.result)),
      ),
    })),
  }
}

// An attempt's status: its result, or where it is in the queue. Every done row has a result (expiry
// saves one too).
const attemptStatus = (queueStatus: QueueRow['status'], result: 'passed' | 'failed' | null) =>
  result ?? (queueStatus === 'leased' ? 'leased' : 'pending')

const TIMELINE_LIMIT = 1000

// A run's summary and timeline. Reads every attempt of the run, but only the small columns: the
// error text and files come a page at a time from listAttempts().
export async function getRun(id: number): Promise<RunDetail | null> {
  // now: the database clock, the same as every timestamp below
  const [found] = await db
    .select({ run: runs, now: sql<Date>`now()`.mapWith(runs.createdAt) })
    .from(runs)
    .where(eq(runs.id, id))
  if (!found) return null
  const { run, now } = found

  const rows = await db
    .select({
      queueId: queue.id,
      slot: queue.slot,
      scenarioId: queue.scenarioId,
      attempt: queue.attempt,
      device: queue.device,
      queueStatus: queue.status,
      leasedAt: queue.leasedAt,
      result: results.status,
      finishedAt: results.createdAt,
    })
    .from(queue)
    .leftJoin(results, eq(results.queueId, queue.id))
    .where(eq(queue.runId, id))
    .orderBy(asc(queue.id))

  const durationMs = runDuration(run)
  const bySlot = new Map<number, { id: string; status: ScenarioStatus }>()
  const byDevice = new Map<string, { attempts: number; busyMs: number }>()

  for (const a of rows) {
    // attempts are in order: the latest decides
    bySlot.set(a.slot, { id: a.scenarioId, status: scenarioStatus(run, a.attempt, a.result) })

    if (a.device && a.leasedAt && a.finishedAt) {
      const stats = byDevice.get(a.device) ?? { attempts: 0, busyMs: 0 }
      stats.attempts++
      stats.busyMs += a.finishedAt.getTime() - a.leasedAt.getTime()
      byDevice.set(a.device, stats)
    }
  }

  const taken = rows
    .flatMap((a) => (a.leasedAt ? [{ ...a, leasedAt: a.leasedAt }] : []))
    .sort((a, b) => a.leasedAt.getTime() - b.leasedAt.getTime())
  return {
    ...run,
    durationMs,
    now,
    timeline: taken.slice(0, TIMELINE_LIMIT).map((a) => ({
      queueId: a.queueId,
      scenarioId: a.scenarioId,
      attempt: a.attempt,
      device: a.device,
      status: attemptStatus(a.queueStatus, a.result),
      leasedAt: a.leasedAt,
      finishedAt: a.finishedAt,
    })),
    timelineCut: taken.length > TIMELINE_LIMIT,
    scenarios: [...bySlot.values()],
    devices: [...byDevice].map(([name, s]) => ({
      name,
      ...s,
      idleMs: durationMs === null ? null : durationMs - s.busyMs,
    })),
  }
}

const ATTEMPTS_PAGE = 50

// One page of a run's attempts with their errors and files, failures first (R24).
export async function listAttempts(runId: number, page: number): Promise<AttemptPage | null> {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) })
  if (!run) return null
  const rows = await db
    .select({
      queueId: queue.id,
      slot: queue.slot,
      scenarioId: queue.scenarioId,
      attempt: queue.attempt,
      device: queue.device,
      queueStatus: queue.status,
      leasedAt: queue.leasedAt,
      result: results.status,
      finishedAt: results.createdAt,
      durationMs: results.durationMs,
      error: results.error,
      screenshot: results.screenshot,
      log: results.log,
    })
    .from(queue)
    .leftJoin(results, eq(results.queueId, queue.id))
    .where(eq(queue.runId, runId))
    .orderBy(
      // failures first: they are what people open a run for
      sql`case when ${results.status} = 'failed' then 0 when ${queue.status} = 'leased' then 1
        when ${queue.status} = 'pending' then 2 else 3 end`,
      asc(queue.id),
    )
    .limit(ATTEMPTS_PAGE + 1) // one more tells if there is a next page
    .offset(page * ATTEMPTS_PAGE)

  const attempts: Attempt[] = rows
    .slice(0, ATTEMPTS_PAGE)
    .map(({ queueStatus, result, screenshot, log, ...a }) => ({
      ...a,
      status: attemptStatus(queueStatus, result),
      screenshot: screenshot !== null,
      log: log !== null,
    }))
  return { attempts, next: rows.length > ATTEMPTS_PAGE ? page + 1 : null, runStatus: run.status }
}

// --- leasing ---------------------------------------------------------------------------------

export class UnknownDeviceError extends Error {}

export async function leaseNext(
  deviceName: string,
  commits: string[],
  currentRunId = 0,
): Promise<Lease | null> {
  return db.transaction(async (tx) => {
    const device = await tx.query.devices.findFirst({
      where: and(eq(devices.name, deviceName), eq(devices.enabled, true)),
    })
    if (!device) throw new UnknownDeviceError(`unknown or disabled device: ${deviceName}`)

    // The phone's current run first (a new run means a new session and app install), then the
    // oldest run. SKIP LOCKED: if another phone is taking a row right now, take the next one.
    const [row] = await tx
      .select({ id: queue.id, run: runs })
      .from(queue)
      .innerJoin(runs, eq(runs.id, queue.runId))
      .where(
        and(
          eq(queue.status, 'pending'),
          eq(runs.platform, device.platform),
          inArray(runs.commit, commits), // only runs whose scenarios this runner has
          or(isNull(queue.assignedDevice), eq(queue.assignedDevice, device.name)),
        ),
      )
      .orderBy(desc(sql`${queue.runId} = ${currentRunId}`), asc(queue.runId), asc(queue.id))
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
        leasedAt: sql`now()`,
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
  const saved = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(queue)
      .set({ status: 'done' })
      .where(
        and(eq(queue.id, body.queueId), eq(queue.device, body.device), eq(queue.status, 'leased')),
      )
      .returning()
    if (!row) return false

    // The slot keeps names apart when a scenario repeats in one run.
    const name = `${row.scenarioId}-${row.slot}-${row.attempt}`
    await recordAttempt(tx, row, {
      status: body.status,
      durationMs: body.durationMs,
      error: body.error,
      screenshot:
        body.screenshot &&
        (await saveArtifact(row.runId, `${name}.png`, Buffer.from(body.screenshot, 'base64'))),
      log: body.log && (await saveArtifact(row.runId, `${name}.log`, body.log)),
    })
    return true
  })
  // A finished attempt frees its account and may have queued a retry: waiting phones look again.
  if (saved) notifyWork()
  return saved
}

// A lease that ran out means the worker died: count it as a failed attempt.
export async function expireLeases() {
  const expired = await db.transaction(async (tx) => {
    const rows = await tx
      .update(queue)
      .set({ status: 'done' })
      .where(and(eq(queue.status, 'leased'), lt(queue.leaseUntil, sql`now()`)))
      .returning()
    for (const row of rows) {
      const error = `lease expired: lost contact with device ${row.device}`
      await recordAttempt(tx, row, { status: 'failed', durationMs: 0, error })
    }
    return rows.length
  })
  if (expired > 0) notifyWork()
}

// A run is stuck when no phone of its platform has taken or finished any work for
// STUCK_RUN_MINUTES (no phone connected, or a fixed split's phone is gone). It fails with its
// open items, so nobody waits forever. Slow runs, and runs waiting behind others, keep going.
// ponytail: scans the queue's history every minute; add an index on leased_at if it gets slow.
export async function expireRuns() {
  await db.transaction(async (tx) => {
    const cutoff = sql`now() - make_interval(mins => ${config.STUCK_RUN_MINUTES})`
    const stuck = await tx.execute<{ id: number; platform: string }>(sql`
      SELECT r.id, r.platform FROM ${runs} r
      WHERE r.status = 'running' AND r.created_at < ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM ${queue} q
          JOIN ${runs} r2 ON r2.id = q.run_id
          LEFT JOIN ${results} res ON res.queue_id = q.id
          WHERE r2.platform = r.platform
            AND (q.status = 'leased' OR q.leased_at > ${cutoff} OR res.created_at > ${cutoff}))`)
    for (const run of stuck.rows) {
      const open = await tx
        .update(queue)
        .set({ status: 'done' })
        .where(and(eq(queue.runId, run.id), ne(queue.status, 'done')))
        .returning()
      const error = `stuck: no ${run.platform} phone took or finished any work for ${config.STUCK_RUN_MINUTES} minutes`
      for (const row of open) await saveResult(tx, row, { status: 'failed', durationMs: 0, error })
      await finishRunIfDone(tx, run.id)
    }
  })
}

type Outcome = Pick<ResultBody, 'status' | 'durationMs' | 'error'> & {
  screenshot?: string
  log?: string
}

function saveResult(tx: Tx, row: QueueRow, outcome: Outcome) {
  return tx.insert(results).values({
    queueId: row.id,
    runId: row.runId,
    scenarioId: row.scenarioId,
    attempt: row.attempt,
    device: row.device,
    ...outcome,
  })
}

// Saves the result of a finished attempt, queues a retry if allowed, and closes the run when
// nothing is left.
async function recordAttempt(tx: Tx, row: QueueRow, outcome: Outcome) {
  await saveResult(tx, row, outcome)

  if (outcome.status === 'failed' && row.attempt < config.MAX_ATTEMPTS) {
    // Same slot, any phone: in a fixed split the assigned phone may be the problem.
    await tx.insert(queue).values({
      runId: row.runId,
      slot: row.slot,
      scenarioId: row.scenarioId,
      attempt: row.attempt + 1,
    })
    return
  }

  await finishRunIfDone(tx, row.runId)
}

async function finishRunIfDone(tx: Tx, runId: number) {
  // Lock the run first, so two attempts finishing at the same moment cannot both miss the end.
  await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).for('update')

  const open = await tx.execute(
    sql`SELECT 1 FROM ${queue} WHERE run_id = ${runId} AND status <> 'done' LIMIT 1`,
  )
  if (open.rows.length > 0) return

  // Failed = some slot has no passing attempt.
  const failed = await tx.execute(sql`
    SELECT 1 FROM ${queue} q
    WHERE q.run_id = ${runId}
      AND NOT EXISTS (
        SELECT 1 FROM ${queue} q2 JOIN ${results} r ON r.queue_id = q2.id
        WHERE q2.run_id = ${runId} AND q2.slot = q.slot AND r.status = 'passed')
    LIMIT 1`)
  await tx
    .update(runs)
    .set({ status: failed.rows.length > 0 ? 'failed' : 'passed', finishedAt: sql`now()` })
    .where(eq(runs.id, runId))
}
