// All queue logic lives here (R6): creating runs, leasing, heartbeats, results, expiry and retries.

import {
  type Attempt,
  type AttemptPage,
  type Catalog,
  type CreateRunBody,
  countStatuses,
  type Lease,
  messageOf,
  type ResultBody,
  type RunDetail,
  type RunList,
  type RunSummary,
  type ScenarioStatus,
} from '@nowait/shared'
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { config } from './config.ts'
import { db } from './db/index.ts'
import { accounts, catalogs, devices, queue, results, runs } from './db/schema.ts'
import { saveArtifact } from './storage/index.ts'

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
  return insertRun({ ...body, commit: catalog.commit }, items)
}

type NewRun = Pick<Run, 'platform' | 'appBuild' | 'commit' | 'trigger' | 'split'>

// Saves a run and queues its items (scenario ids, in order), then wakes waiting phones.
async function insertRun(newRun: NewRun, items: string[]) {
  // fixed: deal the items out to the phones up front, round robin, like the old framework.
  const phones =
    newRun.split === 'fixed'
      ? (
          await db
            .select({ name: devices.name })
            .from(devices)
            .where(and(eq(devices.platform, newRun.platform), eq(devices.enabled, true)))
            .orderBy(asc(devices.name))
        ).map((d) => d.name)
      : []
  if (newRun.split === 'fixed' && phones.length === 0) {
    throw new BadRunError(`no enabled ${newRun.platform} phones to split the run across`)
  }

  const runId = await db.transaction(async (tx) => {
    const [run] = await tx.insert(runs).values(newRun).returning({ id: runs.id })
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

// When a lease taken or renewed now runs out.
const leaseEnd = (seconds = config.LEASE_SECONDS) => sql`now() + make_interval(secs => ${seconds})`

// A result's uploads get at most UPLOAD_SECONDS: past that a file counts as not saved (R50). Its
// lease is renewed for longer than that, so the result is always recorded before the lease ends
// (R34). The S3 client's own timeouts only catch idle sockets, so this limit is the real one.
const UPLOAD_SECONDS = 100
const RENEW_SECONDS = UPLOAD_SECONDS + 30

// A promise that gives up after `ms` (the work itself may still finish in the background).
function within<T>(ms: number, work: Promise<T>) {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`took more than ${ms / 1000} s`)), ms)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

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

// The small columns of an attempt: the timeline reads these, the attempts pages add the big ones.
const attemptColumns = {
  queueId: queue.id,
  slot: queue.slot,
  scenarioId: queue.scenarioId,
  attempt: queue.attempt,
  device: queue.device,
  queueStatus: queue.status,
  leasedAt: queue.leasedAt,
  result: results.status,
  finishedAt: results.createdAt,
}

// A run's summary (Jenkins polls it): each scenario's latest status, and each phone's busy time.
export async function getRun(id: number): Promise<RunSummary | null> {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, id) })
  return run ? summarize(run) : null
}

// Each scenario of the run (catalog x repeat), in order, with its status from its latest attempt.
// Jenkins needs them all, so not paged.
async function scenariosOf(run: Run) {
  const latest = await db
    .selectDistinctOn([queue.slot], {
      scenarioId: queue.scenarioId,
      attempt: queue.attempt,
      result: results.status,
    })
    .from(queue)
    .leftJoin(results, eq(results.queueId, queue.id))
    .where(eq(queue.runId, run.id))
    .orderBy(queue.slot, desc(queue.attempt))
  return latest.map((a) => ({ id: a.scenarioId, status: scenarioStatus(run, a.attempt, a.result) }))
}

async function summarize(run: Run): Promise<RunSummary> {
  // busy = holding a lease, from lease to result; summed by the database, one row per phone
  const phones = await db
    .select({
      name: queue.device,
      attempts: count(),
      busyMs:
        sql<number>`sum(extract(epoch from ${results.createdAt} - ${queue.leasedAt}) * 1000)`.mapWith(
          Number,
        ),
    })
    .from(queue)
    .innerJoin(results, eq(results.queueId, queue.id))
    .where(and(eq(queue.runId, run.id), isNotNull(queue.leasedAt)))
    .groupBy(queue.device)
    .orderBy(queue.device)

  const durationMs = runDuration(run)
  return {
    ...run,
    durationMs,
    scenarios: await scenariosOf(run),
    devices: phones.flatMap(({ name, attempts, busyMs }) => {
      if (!name) return []
      const busy = Math.round(busyMs)
      return [
        { name, attempts, busyMs: busy, idleMs: durationMs === null ? null : durationMs - busy },
      ]
    }),
  }
}

const TIMELINE_LIMIT = 1000

// A run for its dashboard page: the summary, the database clock, and the first TIMELINE_LIMIT
// attempts in the order phones took them (R24). The attempts themselves come from listAttempts().
export async function getRunDetail(id: number): Promise<RunDetail | null> {
  // now: the database clock, the same as every timestamp
  const [found] = await db
    .select({ run: runs, now: sql<Date>`now()`.mapWith(runs.createdAt) })
    .from(runs)
    .where(eq(runs.id, id))
  if (!found) return null

  const taken = await db
    .select(attemptColumns)
    .from(queue)
    .leftJoin(results, eq(results.queueId, queue.id))
    .where(and(eq(queue.runId, id), isNotNull(queue.leasedAt)))
    .orderBy(asc(queue.leasedAt), asc(queue.id))
    .limit(TIMELINE_LIMIT + 1) // one more tells if the timeline is cut

  return {
    ...(await summarize(found.run)),
    now: found.now,
    timeline: taken.slice(0, TIMELINE_LIMIT).map(({ slot, queueStatus, result, ...a }) => ({
      ...a,
      status: attemptStatus(queueStatus, result),
    })),
    timelineCut: taken.length > TIMELINE_LIMIT,
  }
}

const ATTEMPTS_PAGE = 50

// One page of a run's attempts with their errors and files (R24). A finished run lists failures
// first. A running one lists them in queue order: its statuses still change, and a moving order
// would shift rows between pages.
export async function listAttempts(runId: number, page: number): Promise<AttemptPage | null> {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) })
  if (!run) return null
  const failuresFirst = sql`case when ${results.status} = 'failed' then 0 else 1 end`
  const rows = await db
    .select({
      ...attemptColumns,
      durationMs: results.durationMs,
      error: results.error,
      screenshot: results.screenshot,
      log: results.log,
    })
    .from(queue)
    .leftJoin(results, eq(results.queueId, queue.id))
    .where(eq(queue.runId, runId))
    .orderBy(...(run.status === 'running' ? [] : [failuresFirst]), asc(queue.id))
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
          // a fixed split's item is its phone's, or anyone's once that phone is off
          or(
            isNull(queue.assignedDevice),
            eq(queue.assignedDevice, device.name),
            sql`not exists (select 1 from ${devices} d where d.name = ${queue.assignedDevice} and d.enabled)`,
          ),
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
        leaseUntil: leaseEnd(),
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
    .set({ leaseUntil: leaseEnd() })
    .where(and(eq(queue.id, queueId), eq(queue.device, device), eq(queue.status, 'leased')))
    .returning({ id: queue.id })
  return updated.length > 0
}

// --- finishing attempts ----------------------------------------------------------------------

// Returns false when the lease is no longer this device's (it expired and the scenario moved on).
export async function submitResult(body: ResultBody) {
  const leasedHere = and(
    eq(queue.id, body.queueId),
    eq(queue.device, body.device),
    eq(queue.status, 'leased'),
  )
  // The files go up before the transaction: S3 is network I/O, and a transaction must not hold a
  // connection and the row lock while it waits. A result for a lease that is gone uploads nothing.
  // The runner stops its heartbeat before it sends the result, so the lease is renewed here, for
  // the longer of a lease and the upload window: a slow upload must not let it run out and turn
  // this result into "lease expired" (R34).
  const renewFor = Math.max(config.LEASE_SECONDS, RENEW_SECONDS)
  const [row] = await db
    .update(queue)
    .set({ leaseUntil: leaseEnd(renewFor) })
    .where(leasedHere)
    .returning()
  if (!row) return { saved: false, problems: [] }
  // The slot keeps names apart when a scenario repeats in one run.
  const name = `${row.scenarioId}-${row.slot}-${row.attempt}`
  // A file that can't be stored never changes the result (R50): it is saved without it. The result
  // only says which file is missing (it shows on the dashboard and in chat); the store's own error,
  // which can name buckets and request ids, goes to the server log (`problems`).
  const upload = (file: string, data: Buffer | string) =>
    within(UPLOAD_SECONDS * 1000, saveArtifact(row.runId, file, data))
  const [screenshot, log] = await Promise.allSettled([
    body.screenshot && upload(`${name}.png`, Buffer.from(body.screenshot, 'base64')),
    body.log && upload(`${name}.log`, body.log),
  ])
  const failed = Object.entries({ screenshot, log }).flatMap(([file, r]) =>
    r.status === 'rejected' ? [{ file, why: messageOf(r.reason) }] : [],
  )
  const problems = failed.map(({ file, why }) => `${file} not saved: ${why}`)
  const kept = (r: typeof screenshot) => (r.status === 'fulfilled' && r.value) || undefined
  // The test's own error stays the first line: chat shows the first line as the reason.
  const notes = failed.map(({ file }) => `(${file} not saved: the artifact store failed)`)
  // || not ??: an empty error counts as none
  const testError =
    body.error || (body.status === 'failed' && notes.length ? 'no error message' : '')
  const error = [testError, ...notes].filter(Boolean).join('\n') || undefined

  const saved = await db.transaction(async (tx) => {
    // the lease may have run out while the files went up
    const [done] = await tx.update(queue).set({ status: 'done' }).where(leasedHere).returning()
    if (!done) return false
    await recordAttempt(tx, done, {
      status: body.status,
      durationMs: body.durationMs,
      error,
      screenshot: kept(screenshot),
      log: kept(log),
    })
    return true
  })
  // A finished attempt frees its account and may have queued a retry: waiting phones look again.
  if (saved) notifyWork()
  return { saved, problems }
}

// A lease that ran out means the worker died: count it as a failed attempt.
export async function expireLeases() {
  // A lease that ran out while the server was down is not dead: its runner gets one lease time
  // to heartbeat again before it counts.
  if (process.uptime() < config.LEASE_SECONDS) return
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
  // Time the server was down is not "no progress": phones need STUCK_RUN_MINUTES of uptime to
  // come back before a run can count as stuck.
  if (process.uptime() < config.STUCK_RUN_MINUTES * 60) return
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
      const error = `stuck: no ${run.platform} phone took or finished any work for ${config.STUCK_RUN_MINUTES} minutes`
      await closeRun(tx, run.id, error)
    }
  })
}

// Fails every open item of a run with `error`, and finishes the run. A phone that holds one of
// them finds its lease gone at its next heartbeat, and stops.
async function closeRun(tx: Tx, runId: number, error: string) {
  // Again until none is left: a result saved while this ran can queue a retry this update missed.
  while (true) {
    const open = await tx
      .update(queue)
      .set({ status: 'done' })
      .where(and(eq(queue.runId, runId), ne(queue.status, 'done')))
      .returning()
    if (open.length === 0) break
    for (const row of open) await saveResult(tx, row, { status: 'failed', durationMs: 0, error })
  }
  await finishRunIfDone(tx, runId)
}

// --- dashboard actions -----------------------------------------------------------------------

// Stops a running run: its open items fail with "cancelled". False when it is already finished.
export async function cancelRun(runId: number) {
  const cancelled = await db.transaction(async (tx) => {
    // No lock on the run here: queue rows first, then the run (in finishRunIfDone), the same order
    // as a result being saved, or the two could deadlock. Two cancels at once both answer 204.
    const [run] = await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, runId))
    if (!run) return null
    if (run.status !== 'running') return false
    await closeRun(tx, runId, 'cancelled on the dashboard')
    return true
  })
  if (cancelled) notifyWork() // freed accounts
  return cancelled
}

// A finished run, started again as a new run with the same build, commit and split. The old run
// keeps its results (chat and Jenkins already have them).
async function startAgain(run: Run, scenarioIds: string[], trigger: string) {
  if (run.status === 'running') throw new BadRunError(`run #${run.id} is still running`)
  if (scenarioIds.length === 0) throw new BadRunError(`run #${run.id} has no failed scenarios`)
  // Phones only take runs on their runner's newest scenario commit or the one before (catalog.ts).
  // ponytail: the 2 newest catalogs stand for that; per-runner commits if runners drift apart.
  const recent = await db
    .select({ commit: catalogs.commit })
    .from(catalogs)
    .orderBy(desc(catalogs.updatedAt))
    .limit(2)
  if (!recent.some((c) => c.commit === run.commit)) {
    throw new BadRunError(
      `the runners no longer have the scenarios of commit ${run.commit.slice(0, 7)}: start a new run instead`,
    )
  }
  const { platform, appBuild, commit, split } = run
  return insertRun({ platform, appBuild, commit, split, trigger }, scenarioIds)
}

// All of a run's scenarios (repeats too), or only the failed ones. Null when there is no such run.
export async function runAgain(runId: number, failedOnly: boolean) {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) })
  if (!run) return null
  const scenarios = await scenariosOf(run)
  const ids = scenarios.filter((s) => !failedOnly || s.status === 'failed').map((s) => s.id)
  const what = failedOnly ? 'failed scenarios' : 'all scenarios'
  return startAgain(run, ids, `dashboard: ${what} of run #${runId}`)
}

// One failed attempt's scenario, as a new run. Null when there is no such attempt.
export async function retryAttempt(queueId: number) {
  const [found] = await db
    .select({ run: runs, scenarioId: queue.scenarioId, result: results.status })
    .from(queue)
    .innerJoin(runs, eq(runs.id, queue.runId))
    .leftJoin(results, eq(results.queueId, queue.id))
    .where(eq(queue.id, queueId))
  if (!found) return null
  if (found.result !== 'failed') throw new BadRunError('only a failed attempt can run again')
  const trigger = `dashboard: ${found.scenarioId} of run #${found.run.id}`
  return startAgain(found.run, [found.scenarioId], trigger)
}

// Turns a phone on or off. A phone that is off finishes its current attempt and takes no more,
// and the other phones take its items in a fixed split. False when there is no such phone.
export async function setDeviceEnabled(name: string, enabled: boolean) {
  const [device] = await db
    .update(devices)
    .set({ enabled })
    .where(eq(devices.name, name))
    .returning({ name: devices.name })
  if (!device) return false
  // its items in a fixed split are now anyone's (leaseNext): waiting phones look again
  if (!enabled) notifyWork()
  return true
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
