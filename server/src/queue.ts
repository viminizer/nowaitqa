// All queue logic lives here (R6): creating runs, leasing, heartbeats, results, expiry and retries.

import { randomUUID } from 'node:crypto'
import {
  type Attempt,
  type AttemptOrigin,
  type AttemptPage,
  type Catalog,
  type CreateRunBody,
  countStatuses,
  type ExecutionProfile,
  evaluateReleaseGate,
  FIXTURE_CLAIM_SECONDS,
  type FixtureClaimBody,
  type FixtureFinishBody,
  type FixtureJob,
  type FixturePage,
  type FixtureReason,
  type FixtureRegisterBody,
  type FixtureState,
  FullCommit,
  InputRuntime,
  inputSource,
  type Lease,
  MAX_ATTEMPT_FIXTURES,
  matchesProfile,
  messageOf,
  type ProgressBody,
  type ReleasePolicy,
  ResolvedInputs,
  type ResultBody,
  type RunDetail,
  type RunList,
  type RunListQuery,
  type RunSummary,
  ScenarioHistoryPage,
  type ScenarioHistoryQuery,
  type ScenarioStatus,
  virtualDeviceClass,
} from '@nowait/shared'
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { config } from './config.ts'
import { db } from './db/index.ts'
import { accounts, catalogs, devices, fixtureResources, queue, results, runs } from './db/schema.ts'
import { saveArtifact } from './storage/index.ts'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type QueueRow = typeof queue.$inferSelect
const fixtureState = sql<FixtureState>`case
  when ${fixtureResources.claim} is not null and ${fixtureResources.claimUntil} <= now()
    then 'quarantined'
  when ${queue.status} = 'done' and ${queue.cleanupPending} and ${fixtureResources.status} = 'pending'
    and not exists (select 1 from ${fixtureResources} owner where owner.queue_id = ${queue.id} and owner.claim is not null)
    then 'quarantined'
  else ${fixtureResources.status} end`
const fixtureReason = sql<FixtureReason | null>`case
  when ${fixtureResources.claim} is not null and ${fixtureResources.claimUntil} <= now()
    then 'cleanup_owner_lost'
  when ${queue.status} = 'done' and ${queue.cleanupPending} and ${fixtureResources.status} = 'pending'
    and not exists (select 1 from ${fixtureResources} owner where owner.queue_id = ${queue.id} and owner.claim is not null)
    then 'execution_unconfirmed'
  when ${fixtureResources.status} = 'pending' and exists (select 1 from ${fixtureResources} later
    where later.queue_id = ${queue.id} and later.id > ${fixtureResources.id} and later.status <> 'cleaned')
    then 'cleanup_dependency'
  else ${fixtureResources.reason} end`

// --- waking long-polling workers -------------------------------------------------------------
// ponytail: in-memory signal, works for one server process. Use Postgres LISTEN/NOTIFY if we
// ever run several.

let waiters: (() => void)[] = []

function notifyWork() {
  const woken = waiters
  waiters = []
  for (const wake of woken) wake()
}

export function waitForWork(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', wake)
      waiters = waiters.filter((w) => w !== wake)
      resolve()
    }
    const timer = setTimeout(wake, ms)
    waiters.push(wake)
    signal.addEventListener('abort', wake, { once: true })
    if (signal.aborted) wake()
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

// Global catalog history is shared by runners. Include closed runs with unconfirmed cleanup,
// whose orphaned executors may still read their checkout. Page runs, not individual queue items.
export async function referencedRevisions(after = 0) {
  const limit = 100
  const found = await db.execute<{ id: number; commit: string; cleanupPending: boolean }>(sql`
    SELECT r.id, r.commit, EXISTS (
      SELECT 1 FROM ${queue} q WHERE q.run_id = r.id AND q.cleanup_pending
    ) OR EXISTS (
      SELECT 1 FROM ${fixtureResources} f JOIN ${queue} q ON q.id = f.queue_id
      WHERE q.run_id = r.id AND f.status <> 'cleaned'
    ) AS "cleanupPending"
    FROM ${runs} r WHERE r.status = 'running' AND r.id > ${after}
    UNION
    SELECT r.id, r.commit, true AS "cleanupPending"
    FROM ${queue} q JOIN ${runs} r ON r.id = q.run_id
    WHERE q.cleanup_pending AND r.id > ${after}
    UNION
    SELECT r.id, r.commit, true AS "cleanupPending"
    FROM ${fixtureResources} f JOIN ${queue} q ON q.id = f.queue_id
    JOIN ${runs} r ON r.id = q.run_id
    WHERE f.status <> 'cleaned' AND r.id > ${after}
    ORDER BY id LIMIT ${limit + 1}`)
  const rows = found.rows.slice(0, limit)
  return {
    revisions: rows.map(({ id, ...row }) => ({ runId: id, ...row })),
    next: found.rows.length > limit ? (rows.at(-1)?.id ?? null) : null,
  }
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
  if (!FullCommit.safeParse(catalog.commit).success)
    throw new BadRunError('a full scenario revision is required; upgrade the catalog runner')
  const scenarioIds = catalog.scenarios
    .filter((s) => s.platforms.includes(body.platform))
    .map((s) => s.id)
  if (scenarioIds.length === 0) {
    throw new BadRunError(`no ${body.platform} scenarios at commit ${catalog.commit}`)
  }
  const items = Array.from({ length: body.repeat }, () => scenarioIds).flat()
  const slots = body.profiles.length
    ? body.profiles.flatMap((profile) => items.map((scenarioId) => ({ scenarioId, profile })))
    : items.map((scenarioId) => ({ scenarioId, profile: null }))
  return insertRun({ ...body, commit: catalog.commit }, slots)
}

type NewRun = Pick<Run, 'platform' | 'appBuild' | 'commit' | 'trigger' | 'split'> & {
  expectedInputs?: ResolvedInputs
  profiles?: ExecutionProfile[]
  releasePolicy: ReleasePolicy
  rerunOf?: number
  partialCoverage?: boolean
}
type RunSlot = { scenarioId: string; profile: ExecutionProfile | null }

// How long each scenario usually takes on a platform: the average of its last EXPECTED_FROM
// passing attempts. Failed ones don't count: a failure can stop early or run into a timeout.
// A scenario without a pass yet is missing from the map.
const EXPECTED_FROM = 10

async function expectedTimes(platform: Run['platform'], scenarioIds: string[]) {
  const ids = [...new Set(scenarioIds)]
  // one small index read per scenario (results_passed_idx), not the whole history.
  const rows = await db.execute<{ id: string; ms: number | null }>(sql`
    SELECT s.id, (
      SELECT round(avg(last.duration_ms))::int FROM (
        SELECT r.duration_ms FROM ${results} r
        WHERE r.scenario_id = s.id AND r.status = 'passed' AND r.platform = ${platform}
        ORDER BY r.id DESC LIMIT ${EXPECTED_FROM}) last
    ) AS ms
    FROM unnest(${sql.param(ids)}::text[]) AS s(id)`)
  return new Map(rows.rows.flatMap((r) => (r.ms === null ? [] : [[r.id, r.ms] as const])))
}

// Saves a run and queues its items (scenario ids, in order), then wakes waiting phones. Each item
// gets its scenario's expected time, so phones take the longest first (leaseNext).
async function insertRun(newRun: NewRun, items: RunSlot[]) {
  const { expectedInputs, profiles = [], ...fields } = newRun
  // fixed: deal the items out to the phones up front, round robin, like the old framework.
  const phones =
    newRun.split === 'fixed'
      ? await db
          .select({
            name: devices.name,
            platform: devices.platform,
            udid: devices.udid,
            platformVersion: devices.platformVersion,
          })
          .from(devices)
          .where(
            and(
              eq(devices.platform, newRun.platform),
              eq(devices.enabled, true),
              sql`coalesce(${devices.pausedUntil} <= now(), true)`,
            ),
          )
          .orderBy(asc(devices.name))
      : []
  if (newRun.split === 'fixed' && profiles.length === 0 && phones.length === 0) {
    throw new BadRunError(`no enabled ${newRun.platform} phones to split the run across`)
  }
  const expected = await expectedTimes(
    newRun.platform,
    items.map((i) => i.scenarioId),
  )

  const runId = await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(runs)
      .values({
        ...fields,
        profiles: profiles.length ? profiles : null,
        inputIntent: {
          version: 1,
          platform: fields.platform,
          commit: fields.commit,
          appSource: inputSource(fields.appBuild),
          scenarios: items.map((i) => i.scenarioId),
          profiles,
          split: fields.split,
        },
        expectedInputs,
        maxAttempts: config.MAX_ATTEMPTS,
        maxInfrastructureRecoveries: config.MAX_INFRA_RECOVERIES,
        maxRunInfrastructureRecoveries: config.MAX_RUN_INFRA_RECOVERIES,
      })
      .returning({ id: runs.id })
    if (!run) throw new Error('run insert returned nothing')
    await tx.insert(queue).values(
      items.map(({ scenarioId, profile }, slot) => {
        const eligible = phones.filter((d) => !profile || matchesProfile(d, profile))
        return {
          runId: run.id,
          slot,
          scenarioId,
          profile,
          assignedDevice: eligible[slot % eligible.length]?.name,
          expectedMs: expected.get(scenarioId),
        }
      }),
    )
    return run.id
  })
  notifyWork()
  return runId
}

type Run = typeof runs.$inferSelect

const recoveryOf = (
  run: Pick<
    Run,
    | 'maxAttempts'
    | 'maxInfrastructureRecoveries'
    | 'maxRunInfrastructureRecoveries'
    | 'infrastructureRecoveries'
  >,
): RunSummary['recovery'] =>
  run.maxAttempts === null
    ? null
    : {
        maxAttempts: run.maxAttempts,
        maxInfrastructureRecoveries: run.maxInfrastructureRecoveries ?? 0,
        maxRunInfrastructureRecoveries: run.maxRunInfrastructureRecoveries ?? 0,
        infrastructureRecoveries: run.infrastructureRecoveries,
      }

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
  run: Pick<Run, 'status'>,
  attempt: number,
  result: 'passed' | 'failed' | null,
  queueStatus: QueueRow['status'],
): ScenarioStatus {
  if (result === 'passed') return attempt === 1 ? 'passed' : 'flaky'
  // A latest done row has no successor: either budget can end before the raw attempt limit.
  if (result === 'failed' && (queueStatus === 'done' || run.status !== 'running')) {
    return 'failed'
  }
  return 'pending'
}

const runDuration = (run: Pick<Run, 'createdAt' | 'finishedAt'>) =>
  run.finishedAt && run.finishedAt.getTime() - run.createdAt.getTime()

// Search and status apply before pagination. strpos treats %, _ and backslash as literal text.
export async function listRuns({ before, status, q, limit }: RunListQuery): Promise<RunList> {
  const { inputIntent, resolvedInputs, expectedInputs, profiles, ...columns } =
    getTableColumns(runs)
  const page = await db
    .select(columns)
    .from(runs)
    .where(
      and(
        before ? lt(runs.id, before) : undefined,
        status ? eq(runs.status, status) : undefined,
        q
          ? sql`strpos(lower(concat_ws(' ', ${runs.id}::text, ${runs.appBuild}, ${runs.commit}, ${runs.trigger}, ${runs.platform})), lower(${q})) > 0`
          : undefined,
      ),
    )
    .orderBy(desc(runs.id))
    .limit(limit + 1)
  const hasOlder = page.length > limit
  if (hasOlder) page.pop()
  if (page.length === 0) return { runs: [], older: null }

  // the latest attempt of every scenario in these runs
  const latest = await db
    .selectDistinctOn([queue.runId, queue.slot], {
      runId: queue.runId,
      attempt: queue.scenarioAttempt,
      queueStatus: queue.status,
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
    older: hasOlder ? (page.at(-1)?.id ?? null) : null,
    runs: page.map((run) => ({
      ...run,
      recovery: recoveryOf(run),
      release: releaseOf(
        run,
        countStatuses(
          (byRun.get(run.id) ?? []).map((a) =>
            scenarioStatus(run, a.attempt, a.result, a.queueStatus),
          ),
        ),
      ),
      durationMs: runDuration(run),
      counts: countStatuses(
        (byRun.get(run.id) ?? []).map((a) =>
          scenarioStatus(run, a.attempt, a.result, a.queueStatus),
        ),
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
  profile: queue.profile,
  attempt: queue.attempt,
  scenarioAttempt: queue.scenarioAttempt,
  infrastructureRecoveries: queue.infrastructureRecoveries,
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
async function scenariosOf(run: Run, connection: Tx | typeof db = db) {
  const latest = await connection
    .selectDistinctOn([queue.slot], {
      scenarioId: queue.scenarioId,
      profile: queue.profile,
      attempt: queue.scenarioAttempt,
      queueStatus: queue.status,
      result: results.status,
      phase: results.phase,
      failureKind: results.failureKind,
      scenarioStarted: sql<
        boolean | null
      >`coalesce(${results.scenarioStarted}, ${queue.scenarioStarted})`,
    })
    .from(queue)
    .leftJoin(results, eq(results.queueId, queue.id))
    .where(eq(queue.runId, run.id))
    .orderBy(queue.slot, desc(queue.attempt))
  return latest.map((a) => ({
    id: a.scenarioId,
    profile: a.profile,
    status: scenarioStatus(run, a.attempt, a.result, a.queueStatus),
    origin: a.result
      ? {
          phase: a.phase ?? 'unknown',
          failureKind: a.failureKind,
          scenarioStarted: a.scenarioStarted,
        }
      : null,
  }))
}

function releaseOf(
  run: Pick<Run, 'releasePolicy' | 'releaseGate' | 'partialCoverage' | 'rerunOf' | 'status'>,
  counts: ReturnType<typeof countStatuses>,
) {
  const policy = run.releasePolicy ?? 'permissive'
  const gate =
    run.releaseGate ??
    (run.releasePolicy && run.status !== 'running'
      ? { policy, status: 'rejected' as const, reason: 'decision_unavailable' as const, counts }
      : evaluateReleaseGate(policy, run.status, counts, !run.partialCoverage))
  return {
    gate,
    source: run.releasePolicy ? ('saved' as const) : ('legacy' as const),
    partialCoverage: run.partialCoverage,
    rerunOf: run.rerunOf,
  }
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
  const scenarios = await scenariosOf(run)
  // Devices are bounded by connected hardware (R24); eligibility is separate from readiness.
  const eligible = run.profiles?.length
    ? await db
        .select()
        .from(devices)
        .where(
          and(
            eq(devices.platform, run.platform),
            eq(devices.enabled, true),
            sql`coalesce(${devices.pausedUntil} <= now(), true)`,
          ),
        )
    : []
  return {
    ...run,
    release: releaseOf(run, countStatuses(scenarios.map((s) => s.status))),
    inputManifest: {
      intent: run.inputIntent,
      expected: run.expectedInputs,
      resolved: run.resolvedInputs,
    },
    profiles: run.profiles ?? [],
    coverage: (run.profiles ?? [])
      .filter((profile) => scenarios.some((s) => s.profile?.name === profile.name))
      .map((profile) => ({
        profile,
        counts: countStatuses(
          scenarios.filter((s) => s.profile?.name === profile.name).map((s) => s.status),
        ),
        availability: eligible.some((d) => matchesProfile(d, profile))
          ? ('available' as const)
          : ('no_matching_device' as const),
      })),
    recovery: recoveryOf(run),
    durationMs,
    scenarios,
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
      diagnostics: sql<boolean>`${results.diagnostics} IS NOT NULL`,
      progress: queue.progress,
      fixtureCleanup: sql<Attempt['fixtureCleanup']>`(select case
        when count(*) = 0 then 'none'
        when bool_or((${fixtureState}) = 'quarantined') then 'quarantined'
        when bool_or(${fixtureResources.status} <> 'cleaned') then 'pending'
        else 'cleaned' end from ${fixtureResources} where ${fixtureResources.queueId} = ${queue.id})`,
      log: results.log,
      phase: sql<
        AttemptOrigin['phase']
      >`coalesce(${results.phase}, case when ${queue.scenarioStarted} then 'scenario' else 'unknown' end)`,
      failureKind: results.failureKind,
      scenarioStarted: sql<
        boolean | null
      >`coalesce(${results.scenarioStarted}, ${queue.scenarioStarted})`,
      recoveryAction: sql<Attempt['recoveryAction']>`coalesce(${results.recoveryAction}, 'none')`,
      recoveryNote: results.recoveryNote,
      retryQueueId: results.retryQueueId,
      inputRuntime: queue.inputRuntime,
      inputsVerified: queue.inputsVerified,
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
export class PausedDeviceError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('device is paused')
  }
}

export async function leaseNext(
  deviceName: string,
  commits: string[],
  currentRunId = 0,
  signal: AbortSignal,
  cleanup = false,
  inputs = false,
  profiles = false,
): Promise<Lease | null> {
  signal.throwIfAborted()
  const lease = await db.transaction(async (tx) => {
    // Serialize leases for this phone, including duplicate runner processes. NO KEY UPDATE
    // still allows result inserts' FK KEY SHARE locks, and serializes with a health pause.
    const [found] = await tx
      .select({
        device: devices,
        pauseSeconds: sql<number>`greatest(0, ceil(extract(epoch from
          (${devices.pausedUntil} - now()))))::int`,
      })
      .from(devices)
      .where(and(eq(devices.name, deviceName), eq(devices.enabled, true)))
      .limit(1)
      .for('no key update')
    signal.throwIfAborted()
    if (!found) throw new UnknownDeviceError(`unknown or disabled device: ${deviceName}`)
    if (found.pauseSeconds > 0) throw new PausedDeviceError(found.pauseSeconds)
    const { device } = found

    // Check after locking the phone, before reserving another job or account. Expiry/result
    // handling must finish the old row before this phone can take more work.
    const [busy] = await tx
      .select({ id: queue.id })
      .from(queue)
      .where(
        and(
          eq(queue.device, device.name),
          or(eq(queue.status, 'leased'), eq(queue.cleanupPending, true)),
        ),
      )
      .limit(1)
    if (busy) return null

    // The phone's current run first (a new run means a new session and app install), then the
    // oldest run. In a run, the longest scenario first, and one with no history yet before all:
    // short ones at the end fill the gaps, so no phone runs a long one alone while the others
    // wait. SKIP LOCKED: if another phone is taking a row right now, take the next one.
    const [row] = await tx
      .select({ id: queue.id, run: runs })
      .from(queue)
      .innerJoin(runs, eq(runs.id, queue.runId))
      .where(
        and(
          eq(queue.status, 'pending'),
          eq(runs.platform, device.platform),
          inArray(runs.commit, commits), // only runs whose scenarios this runner has
          inputs ? undefined : isNull(runs.inputIntent),
          or(
            isNull(queue.profile),
            profiles &&
              inputs &&
              cleanup &&
              device.platformVersion &&
              virtualDeviceClass(device.platform, device.udid)
              ? sql`${queue.profile}->>'platformVersion' = ${device.platformVersion} AND ${queue.profile}->>'deviceClass' = ${virtualDeviceClass(device.platform, device.udid)}`
              : sql`false`,
          ),
          // a fixed split's item is its phone's, or anyone's once that phone is off
          or(
            isNull(queue.assignedDevice),
            eq(queue.assignedDevice, device.name),
            sql`not exists (select 1 from ${devices} d where d.name = ${queue.assignedDevice}
              and d.enabled and coalesce(d.paused_until <= now(), true)
              and (${queue.profile} IS NULL OR d.platform_version = ${queue.profile}->>'platformVersion'
                and (CASE WHEN d.platform = 'ios' THEN 'ios-simulator'
                  WHEN d.udid ~ '^emulator-[0-9]+$' THEN 'android-emulator' END) = ${queue.profile}->>'deviceClass'))`,
          ),
        ),
      )
      .orderBy(
        desc(sql`${queue.runId} = ${currentRunId}`),
        asc(queue.runId),
        sql`${queue.expectedMs} desc nulls first`,
        asc(queue.id),
      )
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
        cleanupPending: cleanup,
      })
      .where(eq(queue.id, row.id))
      .returning()
    if (!leased) throw new Error('lease update returned nothing')
    // A disconnect during acquisition rolls back both the queue row and its account claim.
    signal.throwIfAborted()

    return {
      queueId: leased.id,
      runId: row.run.id,
      appBuild: row.run.appBuild,
      commit: row.run.commit,
      scenarioId: leased.scenarioId,
      attempt: leased.attempt,
      account,
      leaseSeconds: config.LEASE_SECONDS,
      sessionResetAt: device.healthSince,
      cleanupRequired: cleanup,
      inputProtocol: 1 as const,
      inputIntent: row.run.inputIntent,
      expectedInputs: row.run.resolvedInputs ?? row.run.expectedInputs,
      profile: leased.profile,
      profileProtocol: 1 as const,
      fixtureProtocol: 1 as const,
      deviceIdentity: {
        udid: device.udid,
        platform: device.platform,
        host: device.host,
        appiumUrl: device.appiumUrl,
        systemPort: device.systemPort,
      },
    }
  })
  // COMMIT is asynchronous too: a disconnect during it needs compensation after it finishes.
  // This row has not been delivered. Expiry or cancellation may already have finished it.
  if (signal.aborted && lease) {
    const returned = await db
      .update(queue)
      .set({
        status: 'pending',
        device: null,
        leasedAt: null,
        leaseUntil: null,
        cleanupPending: false,
      })
      .where(
        and(eq(queue.id, lease.queueId), eq(queue.device, deviceName), eq(queue.status, 'leased')),
      )
      .returning({ id: queue.id })
    // Accounts pointing to pending rows are free (takeAccount), and another poll can take work.
    if (returned.length > 0) notifyWork()
  }
  signal.throwIfAborted()
  return lease
}

// Returns a free account's username, null when the pool is empty (the app needs no login),
// or false when every account is busy. Leases and unconfirmed cleanup both reserve an account.
async function takeAccount(tx: Tx, queueId: number): Promise<string | null | false> {
  const free = await tx.execute<{ username: string }>(sql`
    SELECT a.username FROM ${accounts} a
    WHERE (a.queue_id IS NULL
       OR NOT EXISTS (SELECT 1 FROM ${queue} q WHERE q.id = a.queue_id
         AND (q.status = 'leased' OR q.cleanup_pending)))
      AND NOT EXISTS (SELECT 1 FROM ${fixtureResources} f
        WHERE f.queue_id = a.queue_id AND f.status <> 'cleaned')
    LIMIT 1 FOR UPDATE SKIP LOCKED`)
  const username = free.rows[0]?.username
  if (!username) {
    const any = await tx.select({ username: accounts.username }).from(accounts).limit(1)
    return any.length === 0 ? null : false
  }
  await tx.update(accounts).set({ queueId }).where(eq(accounts.username, username))
  return username
}

export async function heartbeat(queueId: number, device: string, scenarioStarted?: true) {
  const updated = await db
    .update(queue)
    .set({ leaseUntil: leaseEnd(), ...(scenarioStarted ? { scenarioStarted: true } : {}) })
    .where(
      and(
        eq(queue.id, queueId),
        eq(queue.device, device),
        eq(queue.status, 'leased'),
        scenarioStarted
          ? sql`((${queue.profile} IS NULL OR ${queue.inputRuntime} IS NOT NULL) AND (${queue.inputsVerified} OR NOT EXISTS (SELECT 1 FROM ${runs} r WHERE r.id = ${queue.runId} AND r.input_intent IS NOT NULL)))`
          : undefined,
      ),
    )
    .returning({ id: queue.id })
  return updated.length > 0
}

// Idempotent acknowledgement after execution stopped and session cleanup was confirmed. A leased
// row remains busy until its result/expiry; a cancelled/expired row can now release its resources.
export async function releaseLease(queueId: number, device: string) {
  const changed = await db
    .update(queue)
    .set({ cleanupPending: false })
    .where(
      and(
        eq(queue.id, queueId),
        eq(queue.device, device),
        sql`not exists (select 1 from ${fixtureResources} f where f.queue_id = ${queue.id} and f.claim is not null)`,
      ),
    )
    .returning({ id: queue.id })
  if (changed.length > 0) notifyWork()
  return changed.length > 0
}

// --- finishing attempts ----------------------------------------------------------------------

// Returns false when the lease is no longer this device's (it expired and the scenario moved on).
// Progress does not renew authority or count as scenario progress. Stale publishers cannot
// overwrite a later snapshot or a completed attempt.
export async function recordProgress(body: ProgressBody) {
  const updated = await db
    .update(queue)
    .set({ progress: body.progress })
    .where(
      and(
        eq(queue.id, body.queueId),
        eq(queue.device, body.device),
        eq(queue.status, 'leased'),
        sql`${queue.leaseUntil} > now()`,
        sql`COALESCE((${queue.progress}->>'revision')::integer, 0) < ${body.progress.revision}`,
      ),
    )
    .returning({ id: queue.id })
  return updated.length > 0
}

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
  if (
    (!row.inputsVerified || (row.profile && !row.inputRuntime)) &&
    (body.status === 'passed' || body.scenarioStarted === true)
  ) {
    const run = await db.query.runs.findFirst({ where: eq(runs.id, row.runId) })
    if (run?.inputIntent)
      throw new InputConflictError('verify run inputs before scenario execution or a passed result')
  }
  // The slot keeps names apart when a scenario repeats in one run.
  const name = `${row.scenarioId}-${row.slot}-${row.attempt}`
  // A file that can't be stored never changes the result (R50): it is saved without it. The result
  // only says which file is missing (it shows on the dashboard and in chat); the store's own error,
  // which can name buckets and request ids, goes to the server log (`problems`).
  const upload = (file: string, data: Buffer | string) =>
    within(UPLOAD_SECONDS * 1000, saveArtifact(row.runId, file, data))
  const [screenshot, log, diagnostics] = await Promise.allSettled([
    body.screenshot && upload(`${name}.png`, Buffer.from(body.screenshot, 'base64')),
    body.log && upload(`${name}.log`, body.log),
    body.diagnostics && upload(`${name}.diagnostics.json`, JSON.stringify(body.diagnostics)),
  ])
  const failed = Object.entries({ screenshot, log, diagnostics }).flatMap(([file, r]) =>
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
    const [done] = await tx
      .update(queue)
      .set({
        status: 'done',
        ...(body.diagnostics ? { progress: body.diagnostics.progress } : {}),
        ...(body.cleanupComplete ? { cleanupPending: false } : {}),
      })
      .where(leasedHere)
      .returning()
    if (!done) return false
    await recordAttempt(tx, done, {
      status: body.status,
      durationMs: body.durationMs,
      error,
      screenshot: kept(screenshot),
      log: kept(log),
      diagnostics: kept(diagnostics),
      phase: body.phase,
      failureKind: body.failureKind,
      scenarioStarted: body.scenarioStarted,
      cleanupComplete: body.cleanupComplete,
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
    // by run: finishRunIfDone locks each run, and two batches that lock runs in different orders
    // can deadlock
    rows.sort((a, b) => a.runId - b.runId || a.id - b.id)
    for (const row of rows) {
      const error = `lease expired: lost contact with device ${row.device}`
      await recordAttempt(tx, row, {
        status: 'failed',
        durationMs: 0,
        error,
        phase: row.scenarioStarted ? 'scenario' : 'unknown',
        failureKind: 'lease_lost',
        scenarioStarted: row.scenarioStarted,
      })
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
  const failed: string[] = []
  await expireProfileSlots().catch((err) => failed.push(`profile coverage: ${messageOf(err)}`))
  const cutoff = sql`now() - make_interval(mins => ${config.STUCK_RUN_MINUTES})`
  const stuck = await db.execute<{ id: number; platform: string }>(sql`
      SELECT r.id, r.platform FROM ${runs} r
      WHERE r.status = 'running' AND r.profiles IS NULL AND r.created_at < ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM ${queue} q
          JOIN ${runs} r2 ON r2.id = q.run_id
          LEFT JOIN ${results} res ON res.queue_id = q.id
          WHERE r2.platform = r.platform
            AND (q.status = 'leased' OR q.leased_at > ${cutoff} OR res.created_at > ${cutoff}))`)
  // One transaction per run: a run that can't be closed (a deadlock, a bad row) does not undo the
  // others; it is tried again next time (R51).
  for (const run of stuck.rows) {
    const error = `stuck: no ${run.platform} phone took or finished any work for ${config.STUCK_RUN_MINUTES} minutes`
    await db
      .transaction((tx) => closeRun(tx, run.id, error))
      .catch((err) => failed.push(`run ${run.id}: ${messageOf(err)}`))
  }
  if (failed.length > 0) {
    throw new Error(
      `could not close ${failed.length} stuck run(s): ${failed.slice(0, 5).join('; ')}`,
    )
  }
}

// Missing coverage expires independently: progress on another runtime cannot hide it.
// Activity on a compatible device (including an ordinary run) protects work waiting behind it.
async function expireProfileSlots() {
  const cutoff = sql`now() - make_interval(mins => ${config.STUCK_RUN_MINUTES})`
  const idle = (runId: number, profile: ExecutionProfile) => sql`NOT EXISTS (
    SELECT 1 FROM ${queue} q2 JOIN ${runs} r2 ON r2.id = q2.run_id
    JOIN ${devices} d ON d.name = q2.device
    LEFT JOIN ${results} res ON res.queue_id = q2.id
    WHERE r2.platform = (SELECT platform FROM ${runs} WHERE id = ${runId})
      AND (q2.profile->>'platformVersion' = ${profile.platformVersion}
        AND q2.profile->>'deviceClass' = ${profile.deviceClass}
        OR q2.profile IS NULL AND coalesce(q2.input_runtime->>'platformVersion', d.platform_version) = ${profile.platformVersion}
          AND coalesce(q2.input_runtime->>'deviceClass', CASE WHEN d.platform = 'ios' THEN 'ios-simulator'
            WHEN d.udid ~ '^emulator-[0-9]+$' THEN 'android-emulator' END) = ${profile.deviceClass})
      AND (q2.status = 'leased' OR q2.leased_at > ${cutoff} OR res.created_at > ${cutoff}))`
  // Keyset-page every running run so an active first page cannot starve later coverage.
  const failed: string[] = []
  let after = 0
  while (true) {
    const candidates = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.status, 'running'),
          isNotNull(runs.profiles),
          lt(runs.createdAt, cutoff),
          sql`${runs.id} > ${after}`,
        ),
      )
      .orderBy(runs.id)
      .limit(100)
    const last = candidates.at(-1)
    if (!last) break
    after = last.id
    for (const run of candidates) {
      for (const profile of run.profiles ?? []) {
        try {
          await db.transaction(async (tx) => {
            const rows = await tx
              .update(queue)
              .set({ status: 'done' })
              .where(
                and(
                  eq(queue.runId, run.id),
                  eq(queue.status, 'pending'),
                  sql`${queue.profile}->>'name' = ${profile.name}`,
                  idle(run.id, profile),
                ),
              )
              .returning()
            for (const row of rows)
              await saveResult(tx, row, {
                status: 'failed',
                durationMs: 0,
                error: `stuck: required profile ${profile.name} (${profile.deviceClass} ${profile.platformVersion}) made no progress for ${config.STUCK_RUN_MINUTES} minutes`,
                phase: 'queue',
                failureKind: 'run_stuck',
                scenarioStarted: false,
              })
            if (rows.length) await finishRunIfDone(tx, run.id)
          })
        } catch (err) {
          failed.push(`run ${run.id}, profile ${profile.name}: ${messageOf(err)}`)
        }
      }
    }
  }
  if (failed.length)
    throw new Error(`could not expire profile coverage: ${failed.slice(0, 5).join('; ')}`)
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
    for (const row of open)
      await saveResult(tx, row, {
        status: 'failed',
        durationMs: 0,
        error,
        phase: row.leasedAt === null ? 'queue' : row.scenarioStarted ? 'scenario' : 'unknown',
        failureKind: error === 'cancelled on the dashboard' ? 'cancelled' : 'run_stuck',
        scenarioStarted: row.leasedAt === null ? false : row.scenarioStarted,
      })
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
  if (cancelled) notifyWork() // legacy accounts are free; upgraded leases still require cleanup
  return cancelled
}

// A finished run, started again as a new run with the same build, commit and split. The old run
// keeps its results (chat and Jenkins already have them).
async function startAgain(run: Run, items: RunSlot[], trigger: string, partialCoverage: boolean) {
  if (run.status === 'running') throw new BadRunError(`run #${run.id} is still running`)
  if (items.length === 0) throw new BadRunError(`run #${run.id} has no failed scenarios`)
  if (!run.inputIntent || !run.resolvedInputs)
    throw new BadRunError('verified inputs are unavailable for this run; start a new run instead')
  const { platform, appBuild, commit, split } = run
  return insertRun(
    {
      platform,
      appBuild,
      commit,
      split,
      trigger,
      releasePolicy: run.releasePolicy ?? 'permissive',
      rerunOf: run.id,
      partialCoverage: run.partialCoverage || partialCoverage,
      expectedInputs: run.resolvedInputs,
      profiles: run.profiles ?? [],
    },
    items,
  )
}

export class InputConflictError extends Error {}

// Queue→run lock order matches results/cancellation. The first verifier binds the identity;
// every later attempt/replay must resolve the same bytes and effective configuration.
export async function verifyInputs(queueId: number, device: string, inputs: ResolvedInputs) {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(queue)
      .where(
        and(
          eq(queue.id, queueId),
          eq(queue.device, device),
          eq(queue.status, 'leased'),
          sql`${queue.leaseUntil} > now()`,
        ),
      )
      .for('update')
    if (!item) throw new InputConflictError('input verification lease is gone')
    const [run] = await tx.select().from(runs).where(eq(runs.id, item.runId)).for('no key update')
    if (!run?.inputIntent || run.status !== 'running')
      throw new InputConflictError('run input manifest is unavailable')
    if (inputs.scenarios.commit !== run.commit)
      throw new InputConflictError('scenario input revision does not match the run')
    if (
      (run.expectedInputs &&
        JSON.stringify(ResolvedInputs.parse(run.expectedInputs)) !== JSON.stringify(inputs)) ||
      (run.resolvedInputs &&
        JSON.stringify(ResolvedInputs.parse(run.resolvedInputs)) !== JSON.stringify(inputs))
    )
      throw new InputConflictError(
        'resolved app, scenario dependencies or configuration differ from the recorded run inputs',
      )
    if (!run.resolvedInputs)
      await tx.update(runs).set({ resolvedInputs: inputs }).where(eq(runs.id, run.id))
    await tx.update(queue).set({ inputsVerified: true }).where(eq(queue.id, queueId))
    return inputs
  })
}

export async function recordInputRuntime(queueId: number, device: string, runtime: InputRuntime) {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(queue)
      .where(
        and(
          eq(queue.id, queueId),
          eq(queue.device, device),
          eq(queue.status, 'leased'),
          sql`${queue.leaseUntil} > now()`,
        ),
      )
      .for('update')
    if (!item) throw new InputConflictError('runtime observation lease is gone')
    if (!item.inputsVerified)
      throw new InputConflictError('verify inputs before recording runtime observations')
    if (
      item.inputRuntime &&
      JSON.stringify(InputRuntime.parse(item.inputRuntime)) !== JSON.stringify(runtime)
    )
      throw new InputConflictError('runtime observation is already recorded')
    if (
      item.profile &&
      (runtime.platformVersion !== item.profile.platformVersion ||
        runtime.deviceClass !== item.profile.deviceClass)
    )
      throw new InputConflictError(
        `actual device runtime does not match required profile ${item.profile.name}`,
      )
    if (!item.inputRuntime)
      await tx.update(queue).set({ inputRuntime: runtime }).where(eq(queue.id, queueId))
  })
}

export async function inputManifestPage(runId: number, page: number) {
  const items = await listAttempts(runId, page)
  if (!items) return null
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) })
  if (!run) return null
  return {
    manifest: {
      intent: run.inputIntent,
      expected: run.expectedInputs,
      resolved: run.resolvedInputs,
    },
    attempts: items.attempts.map(({ queueId, device, profile, inputRuntime }) => ({
      queueId,
      device,
      profile,
      runtime: inputRuntime,
    })),
    next: items.next,
  }
}

// All of a run's scenarios (repeats too), or only the failed ones. Null when there is no such run.
export async function runAgain(runId: number, failedOnly: boolean) {
  const run = await db.query.runs.findFirst({ where: eq(runs.id, runId) })
  if (!run) return null
  const scenarios = await scenariosOf(run)
  const ids = scenarios
    .filter((s) => !failedOnly || s.status === 'failed')
    .map((s) => ({ scenarioId: s.id, profile: s.profile }))
  const what = failedOnly ? 'failed scenarios' : 'all scenarios'
  return startAgain(run, ids, `dashboard: ${what} of run #${runId}`, failedOnly)
}

// One failed attempt's scenario, as a new run. Null when there is no such attempt.
export async function retryAttempt(queueId: number) {
  const [found] = await db
    .select({
      run: runs,
      scenarioId: queue.scenarioId,
      profile: queue.profile,
      result: results.status,
    })
    .from(queue)
    .innerJoin(runs, eq(runs.id, queue.runId))
    .leftJoin(results, eq(results.queueId, queue.id))
    .where(eq(queue.id, queueId))
  if (!found) return null
  if (found.result !== 'failed') throw new BadRunError('only a failed attempt can run again')
  const trigger = `dashboard: ${found.scenarioId} of run #${found.run.id}`
  return startAgain(
    found.run,
    [{ scenarioId: found.scenarioId, profile: found.profile }],
    trigger,
    true,
  )
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

// Three distinct failures on one phone, each recovered by another phone in the same run, are
// evidence of device trouble. Check outside result transactions: health detection must never
// lose a test result (R50). One transaction per phone, in name order, isolates a bad item (R51).
export async function pauseUnhealthyDevices() {
  // Bounded by physical phones/simulators on the connected machines (R24 hardware exception).
  const phones = await db
    .select({ name: devices.name })
    .from(devices)
    .where(and(eq(devices.enabled, true), sql`coalesce(${devices.pausedUntil} <= now(), true)`))
    .orderBy(devices.name)
  const failed: string[] = []
  let paused = 0
  for (const phone of phones) {
    await db
      .transaction(async (tx) => {
        const [device] = await tx
          .select()
          .from(devices)
          .where(and(eq(devices.name, phone.name), eq(devices.enabled, true)))
          .limit(1)
          .for('no key update', { skipLocked: true })
        if (!device) return
        const until = sql`now() + make_interval(secs => ${config.DEVICE_PAUSE_SECONDS})`
        // Detect and update in one statement snapshot: a success committed before this
        // decision resets the streak. Results themselves never need to wait for this check.
        const changed = await tx.execute(sql`
          WITH evidence AS (
          SELECT f.run_id FROM ${results} f
          JOIN ${queue} fq ON fq.id = f.queue_id
          WHERE f.device = ${device.name} AND f.status = 'failed'
            AND coalesce(${device.pausedUntil}::timestamptz <= now(), true)
            AND fq.leased_at >= ${device.healthSince}
            AND f.created_at > greatest(${device.healthSince}, coalesce((
              SELECT p.created_at FROM ${results} p
              WHERE p.device = ${device.name} AND p.status = 'passed'
              ORDER BY p.created_at DESC LIMIT 1), ${device.healthSince}))
            AND EXISTS (
              SELECT 1 FROM ${queue} pq JOIN ${results} p ON p.queue_id = pq.id
              WHERE pq.run_id = f.run_id AND pq.slot = fq.slot AND pq.attempt > fq.attempt
                AND p.status = 'passed' AND p.device <> f.device)
          GROUP BY f.run_id HAVING count(DISTINCT f.scenario_id) >= 3
          ORDER BY f.run_id DESC LIMIT 1)
          UPDATE ${devices} SET paused_until = ${until}, health_since = ${until},
            pause_reason = '3 different scenarios failed here and passed on other phones in run #' || evidence.run_id
          FROM evidence WHERE ${devices.name} = ${device.name}
          RETURNING ${devices.name}`)
        // Persisting the resume boundary excludes late retries/old in-flight work after recovery.
        return changed.rows.length > 0
      })
      .then((changed) => {
        if (changed) paused++
      })
      .catch((err) => failed.push(`phone ${phone.name}: ${messageOf(err)}`))
  }
  if (paused > 0) notifyWork() // fixed-split items can now go to other phones
  if (failed.length > 0) {
    throw new Error(`could not check ${failed.length} phone(s): ${failed.slice(0, 5).join('; ')}`)
  }
  return paused
}

type Outcome = Pick<
  ResultBody,
  'status' | 'durationMs' | 'error' | 'phase' | 'failureKind' | 'cleanupComplete'
> & {
  scenarioStarted?: boolean | null
  screenshot?: string
  log?: string
  diagnostics?: string
}

function saveResult(tx: Tx, row: QueueRow, outcome: Outcome) {
  return tx.insert(results).values({
    queueId: row.id,
    runId: row.runId,
    scenarioId: row.scenarioId,
    platform: sql`(SELECT platform FROM ${runs} WHERE id = ${row.runId})`,
    attempt: row.attempt,
    device: row.device,
    status: outcome.status,
    durationMs: outcome.durationMs,
    error: outcome.error,
    screenshot: outcome.screenshot,
    log: outcome.log,
    diagnostics: outcome.diagnostics,
    phase:
      row.scenarioStarted && outcome.phase === 'setup' ? 'scenario' : (outcome.phase ?? 'unknown'),
    failureKind:
      outcome.status === 'passed'
        ? null
        : row.scenarioStarted && outcome.failureKind === 'session_unavailable'
          ? 'unknown'
          : (outcome.failureKind ?? 'unknown'),
    scenarioStarted:
      row.scenarioStarted === true ? true : (outcome.scenarioStarted ?? row.scenarioStarted),
  })
}

// Saves the result of a finished attempt, queues a retry if allowed, and closes the run when
// nothing is left.
async function recordAttempt(tx: Tx, row: QueueRow, outcome: Outcome) {
  await saveResult(tx, row, outcome)
  if (outcome.status === 'failed') {
    // Same queue→run lock order as completion/cancellation. Serializes the shared ceiling;
    // NO KEY UPDATE remains compatible with concurrent result inserts' FK KEY SHARE locks.
    const [run] = await tx.select().from(runs).where(eq(runs.id, row.runId)).for('no key update')
    if (run?.status !== 'running') return
    const infrastructure =
      run.maxAttempts !== null &&
      outcome.phase === 'setup' &&
      outcome.failureKind === 'session_unavailable' &&
      outcome.scenarioStarted === false &&
      outcome.cleanupComplete === true &&
      row.scenarioStarted !== true
    const maxAttempts = run.maxAttempts ?? config.MAX_ATTEMPTS
    const slotLimit = run.maxInfrastructureRecoveries ?? 0
    const runLimit = run.maxRunInfrastructureRecoveries ?? 0
    const retry = infrastructure
      ? row.infrastructureRecoveries < slotLimit && run.infrastructureRecoveries < runLimit
      : row.scenarioAttempt < maxAttempts
    let retryQueueId: number | undefined
    if (retry) {
      if (infrastructure)
        await tx
          .update(runs)
          .set({
            infrastructureRecoveries: run.infrastructureRecoveries + 1,
          })
          .where(eq(runs.id, run.id))
      // Any phone, including in a fixed split. The normal lease rules retain old cleanup holds.
      const [next] = await tx
        .insert(queue)
        .values({
          runId: row.runId,
          slot: row.slot,
          scenarioId: row.scenarioId,
          profile: row.profile,
          attempt: row.attempt + 1,
          scenarioAttempt: row.scenarioAttempt + (infrastructure ? 0 : 1),
          infrastructureRecoveries: row.infrastructureRecoveries + (infrastructure ? 1 : 0),
          expectedMs: row.expectedMs,
        })
        .returning({ id: queue.id })
      if (!next) throw new Error('retry insert returned nothing')
      retryQueueId = next.id
    }
    await tx
      .update(results)
      .set({
        recoveryAction: infrastructure
          ? retry
            ? 'infrastructure_retry'
            : 'infrastructure_exhausted'
          : retry
            ? 'scenario_retry'
            : 'scenario_exhausted',
        recoveryNote: infrastructure
          ? `Confirmed session connection refusal; ${retry ? 'new session requested' : 'recovery exhausted'} (slot ${row.infrastructureRecoveries + (retry ? 1 : 0)}/${slotLimit}, run ${run.infrastructureRecoveries + (retry ? 1 : 0)}/${runLimit})`
          : `Scenario attempt ${row.scenarioAttempt}/${maxAttempts}; ${retry ? 'retry requested' : 'no scenario attempts remain'}`,
        retryQueueId,
      })
      .where(eq(results.queueId, row.id))
    if (retry) return
  }

  await finishRunIfDone(tx, row.runId)
}

async function finishRunIfDone(tx: Tx, runId: number) {
  // Lock the run first, so two attempts finishing at the same moment cannot both miss the end.
  // NO KEY UPDATE, not UPDATE: the result this transaction just saved points to the run, which
  // puts a KEY SHARE lock on it, and so did the other attempt's. FOR UPDATE waits on that lock
  // from both sides (a deadlock); NO KEY UPDATE doesn't, and two of them still take turns.
  const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for('no key update')
  // already finished (a cancel or stuck close that raced the last result): keep its end as it is
  if (run?.status !== 'running') return

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
  const status = failed.rows.length > 0 ? ('failed' as const) : ('passed' as const)
  const scenarios = await scenariosOf({ ...run, status }, tx)
  const expected = run.inputIntent?.scenarios ?? []
  const counts = countStatuses(scenarios.map((s) => s.status))
  const actual = scenarios.map((s) => s.id).sort()
  const sameScenarios =
    expected.length === scenarios.length && [...expected].sort().every((id, i) => id === actual[i])
  const complete =
    !run.partialCoverage &&
    sameScenarios &&
    (run.profiles ?? []).every(
      (p) =>
        scenarios.filter((s) => s.profile?.name === p.name).length ===
        expected.length / (run.profiles?.length || 1),
    )
  await tx
    .update(runs)
    .set({
      status,
      finishedAt: sql`now()`,
      releaseGate: run.releasePolicy
        ? evaluateReleaseGate(run.releasePolicy, status, counts, complete)
        : null,
    })
    .where(eq(runs.id, runId))
}

export class FixtureConflictError extends Error {}

// Commit the recovery identity before the child may call a backend. No setup result is stored.
export async function registerFixture(body: FixtureRegisterBody) {
  return db.transaction(async (tx) => {
    const [item] = await tx
      .select({ item: queue, resolved: runs.resolvedInputs })
      .from(queue)
      .innerJoin(runs, eq(runs.id, queue.runId))
      .where(
        and(
          eq(queue.id, body.queueId),
          eq(queue.device, body.device),
          eq(queue.status, 'leased'),
          eq(queue.cleanupPending, true),
          eq(queue.inputsVerified, true),
          sql`${queue.leaseUntil} > now()`,
          sql`(${queue.profile} is null or ${queue.inputRuntime} is not null)`,
        ),
      )
      .for('update', { of: queue })
    if (!item?.resolved)
      throw new FixtureConflictError(
        'fixture setup needs an active, verified attempt before cleanup acknowledgement',
      )
    const existing = await tx
      .select({ name: fixtureResources.name, key: fixtureResources.key })
      .from(fixtureResources)
      .where(eq(fixtureResources.queueId, body.queueId))
      .limit(MAX_ATTEMPT_FIXTURES)
    const same = existing.find((record) => record.name === body.name)
    if (same) return { key: same.key }
    if (existing.length >= MAX_ATTEMPT_FIXTURES)
      throw new FixtureConflictError(`at most ${MAX_ATTEMPT_FIXTURES} fixtures per attempt`)
    const [record] = await tx
      .insert(fixtureResources)
      .values({ queueId: body.queueId, name: body.name, key: randomUUID() })
      .returning({ key: fixtureResources.key })
    if (!record) throw new Error('fixture registration returned nothing')
    return record
  })
}

// Same device→queue lock order as ordinary leases. A cleanup child owns a device hold too:
// losing its parent must never be mistaken for proof that arbitrary adapter code has stopped.
export async function claimFixture(body: FixtureClaimBody): Promise<FixtureJob | null> {
  return db.transaction(async (tx) => {
    const [phone] = await tx
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.name, body.name),
          eq(devices.host, body.host),
          eq(devices.udid, body.udid),
          eq(devices.platform, body.platform),
        ),
      )
      .for('no key update')
    if (!phone) return null
    const [busy] = await tx
      .select({ id: queue.id })
      .from(queue)
      .where(
        and(
          eq(queue.device, body.name),
          or(eq(queue.status, 'leased'), eq(queue.cleanupPending, true)),
        ),
      )
      .limit(1)
    if (busy) return null
    const [found] = await tx
      .select({ resource: fixtureResources, item: queue, run: runs })
      .from(fixtureResources)
      .innerJoin(queue, eq(queue.id, fixtureResources.queueId))
      .innerJoin(runs, eq(runs.id, queue.runId))
      .where(
        and(
          eq(queue.device, body.name),
          eq(queue.status, 'done'),
          eq(queue.cleanupPending, false),
          ne(fixtureResources.status, 'cleaned'),
          isNull(fixtureResources.claim),
          lt(fixtureResources.attempts, config.MAX_FIXTURE_CLEANUP_ATTEMPTS),
          lte(fixtureResources.nextAttemptAt, sql`now()`),
          sql`not exists (select 1 from ${fixtureResources} later where later.queue_id = ${queue.id}
          and later.id > ${fixtureResources.id} and later.status <> 'cleaned')`,
        ),
      )
      .orderBy(asc(fixtureResources.id))
      .limit(1)
      .for('update', { of: queue, skipLocked: true })
    if (!found?.run.resolvedInputs) return null
    const claim = randomUUID()
    await tx.update(queue).set({ cleanupPending: true }).where(eq(queue.id, found.item.id))
    await tx
      .update(fixtureResources)
      .set({
        claim,
        status: 'cleaning',
        reason: null,
        attempts: found.resource.attempts + 1,
        claimUntil: sql`now() + ${FIXTURE_CLAIM_SECONDS} * interval '1 second'`,
        updatedAt: sql`now()`,
      })
      .where(eq(fixtureResources.id, found.resource.id))
    const [account] = await tx
      .select({ username: accounts.username })
      .from(accounts)
      .where(eq(accounts.queueId, found.item.id))
      .limit(1)
    return {
      id: found.resource.id,
      key: found.resource.key,
      name: found.resource.name,
      claim,
      queueId: found.item.id,
      runId: found.run.id,
      commit: found.run.commit,
      scenarioId: found.item.scenarioId,
      scenarios: ResolvedInputs.parse(found.run.resolvedInputs).scenarios,
      config: ResolvedInputs.parse(found.run.resolvedInputs).config,
      account: account?.username ?? null,
    }
  })
}

export async function finishFixture(body: FixtureFinishBody) {
  const saved = await db.transaction(async (tx) => {
    await tx
      .select({ name: devices.name })
      .from(devices)
      .where(eq(devices.name, body.device))
      .for('no key update')
    const [found] = await tx
      .select({ item: queue, resource: fixtureResources })
      .from(queue)
      .innerJoin(fixtureResources, eq(fixtureResources.queueId, queue.id))
      .where(
        and(
          eq(fixtureResources.id, body.id),
          eq(queue.device, body.device),
          eq(queue.status, 'done'),
          eq(fixtureResources.claim, body.claim),
          eq(fixtureResources.status, 'cleaning'),
          sql`${fixtureResources.claimUntil} > now()`,
        ),
      )
      .for('update', { of: queue })
    if (!found) return false
    await tx
      .update(fixtureResources)
      .set({
        status: body.clean ? 'cleaned' : 'quarantined',
        reason: body.clean
          ? null
          : body.stopped
            ? (body.reason ?? 'cleanup_failed')
            : 'executor_unconfirmed',
        ...(body.stopped ? { claim: null, claimUntil: null } : {}),
        nextAttemptAt: sql`now() + ${config.FIXTURE_RETRY_SECONDS} * interval '1 second'`,
        updatedAt: sql`now()`,
      })
      .where(eq(fixtureResources.id, body.id))
    if (body.stopped)
      await tx.update(queue).set({ cleanupPending: false }).where(eq(queue.id, found.item.id))
    if (!body.clean) {
      const note = 'Fixture cleanup was not verified; see Fixtures for current state.'
      await tx
        .update(results)
        .set({
          error: sql`case when position(${note} in coalesce(${results.error}, '')) > 0
        then ${results.error} else concat_ws(E'\n', nullif(${results.error}, ''), ${note}::text) end`,
        })
        .where(eq(results.queueId, found.item.id))
    }
    return true
  })
  if (saved) notifyWork()
  return saved
}

// Global view shows resources still requiring cleanup; an attempt view includes retained clean
// records too. Both use the same bounded keyset page, never a growing per-run array.
export async function listFixtures(after?: number, queueId?: number): Promise<FixturePage> {
  const rows = await db
    .select({
      id: fixtureResources.id,
      key: fixtureResources.key,
      name: fixtureResources.name,
      queueId: queue.id,
      runId: queue.runId,
      scenarioId: queue.scenarioId,
      device: queue.device,
      status: fixtureState,
      reason: fixtureReason,
      attempts: fixtureResources.attempts,
      updatedAt: fixtureResources.updatedAt,
      canRetry: sql<boolean>`${queue.status} = 'done' and ${fixtureResources.status} <> 'cleaned'
      and not exists (select 1 from ${fixtureResources} active where active.queue_id = ${queue.id}
        and active.claim is not null and active.claim_until > now())
      and not exists (select 1 from ${fixtureResources} later where later.queue_id = ${queue.id}
        and later.id > ${fixtureResources.id} and later.status <> 'cleaned')`,
      accountHeld: sql<boolean>`exists(select 1 from ${accounts} a where a.queue_id = ${queue.id}) and ${fixtureResources.status} <> 'cleaned'`,
    })
    .from(fixtureResources)
    .innerJoin(queue, eq(queue.id, fixtureResources.queueId))
    .where(
      and(
        after ? lt(fixtureResources.id, after) : undefined,
        queueId ? eq(queue.id, queueId) : ne(fixtureResources.status, 'cleaned'),
      ),
    )
    .orderBy(desc(fixtureResources.id))
    .limit(51)
  return { fixtures: rows.slice(0, 50), next: rows.length > 50 ? (rows[49]?.id ?? null) : null }
}

// An explicit operator confirmation, never an inference from an expired lease/claim. It covers
// original executor/session processes AND cleanup children plus accepted backend requests.
export async function retryFixture(id: number) {
  await db.transaction(async (tx) => {
    const [resource] = await tx
      .select({ item: queue })
      .from(fixtureResources)
      .innerJoin(queue, eq(queue.id, fixtureResources.queueId))
      .where(eq(fixtureResources.id, id))
      .limit(1)
    if (!resource?.item.device) throw new BadRunError('fixture not found')
    await tx
      .select({ name: devices.name })
      .from(devices)
      .where(eq(devices.name, resource.item.device))
      .for('no key update')
    const [found] = await tx
      .select({
        item: queue,
        resource: fixtureResources,
        canReset: sql<boolean>`not exists (select 1 from ${fixtureResources} active where active.queue_id = ${queue.id}
          and active.claim is not null and active.claim_until > now())
      and not exists (select 1 from ${fixtureResources} later where later.queue_id = ${queue.id}
        and later.id > ${fixtureResources.id} and later.status <> 'cleaned')`,
      })
      .from(queue)
      .innerJoin(fixtureResources, eq(fixtureResources.queueId, queue.id))
      .where(eq(fixtureResources.id, id))
      .for('update', { of: queue })
    if (found?.item.status !== 'done' || found.resource.status === 'cleaned' || !found.canReset)
      throw new BadRunError(
        'cleanup is active, the attempt is unfinished, a later fixture needs cleanup, or the resource is already clean',
      )
    await tx
      .update(fixtureResources)
      .set({
        status: 'pending',
        reason: 'awaiting_cleanup',
        claim: null,
        claimUntil: null,
        attempts: 0,
        nextAttemptAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(fixtureResources.id, id))
    await tx.update(queue).set({ cleanupPending: false }).where(eq(queue.id, found.item.id))
  })
  notifyWork()
}

// Retain uncertain resources indefinitely; deleting their evidence would recycle dirty accounts.
// Verified-clean identities use the existing artifact retention duration and bounded DB batches.
export async function deleteOldFixtureRecords() {
  for (;;) {
    const old = await db
      .select({ id: fixtureResources.id })
      .from(fixtureResources)
      .where(
        and(
          eq(fixtureResources.status, 'cleaned'),
          lt(fixtureResources.updatedAt, sql`now() - ${config.ARTIFACT_DAYS} * interval '1 day'`),
        ),
      )
      .orderBy(asc(fixtureResources.id))
      .limit(1000)
    if (!old.length) return
    await db.delete(fixtureResources).where(
      and(
        inArray(
          fixtureResources.id,
          old.map((r) => r.id),
        ),
        eq(fixtureResources.status, 'cleaned'),
      ),
    )
    if (old.length < 1000) return
  }
}

// Aggregate the entire selected finished-run window before paging cohorts. A slot is one
// sample, not one retry. Unknown/mixed evidence is isolated per run, never silently comparable.
export async function scenarioHistory(query: ScenarioHistoryQuery): Promise<ScenarioHistoryPage> {
  // Run/result timestamps come from Postgres; the runner/server host clock may drift.
  const end =
    query.until ?? (await db.execute<{ now: string }>(sql`SELECT now() AS now`)).rows[0]?.now
  if (!end) throw new Error('database clock unavailable for history window')
  const until = ScenarioHistoryPage.shape.until.parse(end)
  const from = new Date(until.getTime() - query.days * 86_400_000)
  const rows = await db.execute<{ entry: ScenarioHistoryPage['entries'][number] }>(sql`
    WITH attempts AS (
      SELECT q.*, r.commit, r.split, r.resolved_inputs, r.max_attempts, r.max_infrastructure_recoveries, r.max_run_infrastructure_recoveries, r.partial_coverage, r.finished_at AS run_finished,
        res.status AS result_status, res.created_at AS result_at,
        res.status = 'failed' AND res.phase = 'scenario' AND res.scenario_started
          AND res.failure_kind IN ('assertion','scenario_error','timeout') AS application_failure,
        res.status = 'failed' AND res.failure_kind IN
          ('session_unavailable','lease_lost','cancelled','run_stuck','executor_error') AS infrastructure_failure,
        row_number() OVER (PARTITION BY q.run_id, q.slot ORDER BY q.attempt DESC) AS newest
      FROM ${queue} q JOIN ${runs} r ON r.id = q.run_id
      LEFT JOIN ${results} res ON res.queue_id = q.id
      WHERE q.scenario_id = ${query.scenarioId} AND r.platform = ${query.platform}
        AND r.status <> 'running' AND r.finished_at >= ${from} AND r.finished_at <= ${until}
    ), slots AS (
      SELECT run_id, slot, commit, split, resolved_inputs, profile, max_attempts, max_infrastructure_recoveries, max_run_infrastructure_recoveries, partial_coverage,
        max(result_status) FILTER (WHERE newest = 1) AS latest_status,
        max(scenario_attempt) FILTER (WHERE newest = 1) AS scenario_attempt,
        bool_or(application_failure) FILTER (WHERE newest = 1) AS latest_application_failure,
        bool_or(infrastructure_failure) FILTER (WHERE newest = 1) AS latest_infrastructure_failure,
        count(*) FILTER (WHERE infrastructure_failure) AS interruptions,
        count(*) FILTER (WHERE application_failure) AS application_failures,
        count(*) FILTER (WHERE result_status = 'failed' AND NOT coalesce(application_failure, false)
          AND NOT coalesce(infrastructure_failure, false)) AS unknown_failures,
        coalesce(min(result_at), min(leased_at), max(run_finished)) AS first_at,
        coalesce(max(result_at), max(run_finished)) AS last_at,
        count(DISTINCT coalesce(input_runtime, 'null'::jsonb)) AS runtime_count,
        (array_agg(input_runtime ORDER BY attempt) FILTER (WHERE input_runtime IS NOT NULL))[1] AS runtime,
        md5(string_agg(DISTINCT coalesce(input_runtime::text, 'null'), '|' ORDER BY coalesce(input_runtime::text, 'null'))) AS runtime_key,
        bool_and(inputs_verified) AS verified
      FROM attempts
      GROUP BY run_id, slot, commit, split, resolved_inputs, profile, max_attempts, max_infrastructure_recoveries, max_run_infrastructure_recoveries, partial_coverage
    ), identified AS (
      SELECT *,
        resolved_inputs IS NOT NULL AND max_attempts IS NOT NULL AND max_infrastructure_recoveries IS NOT NULL AND max_run_infrastructure_recoveries IS NOT NULL AND verified
          AND runtime_count = 1 AND runtime IS NOT NULL
          AND runtime->>'appium' IS NOT NULL AND runtime->>'automation' IS NOT NULL
          AND runtime->>'driver' IS NOT NULL AND runtime->>'platformVersion' IS NOT NULL AS comparable,
        CASE WHEN runtime_count > 1 THEN 'mixed' WHEN runtime IS NULL THEN 'unknown' ELSE 'verified' END AS runtime_state,
        CASE WHEN latest_status = 'passed' THEN CASE WHEN application_failures > 0 THEN 'later' WHEN scenario_attempt = 1 OR (interruptions > 0 AND unknown_failures = 0) THEN 'first' ELSE 'unknown' END
          WHEN latest_application_failure THEN 'application'
          WHEN application_failures > 0 THEN 'interrupted_application'
          WHEN latest_infrastructure_failure THEN 'infrastructure'
          ELSE 'unknown' END AS outcome
      FROM slots
    ), keyed AS (
      SELECT *, CASE WHEN runtime_state = 'verified' THEN runtime END AS display_runtime, md5(jsonb_build_object('scenario', ${query.scenarioId}::text, 'platform', ${query.platform}::text, 'commit', commit, 'split', split, 'inputs', resolved_inputs,
        'profile', profile, 'runtime', runtime_key, 'partialCoverage', partial_coverage, 'recovery', jsonb_build_object('maxAttempts', max_attempts, 'maxInfrastructureRecoveries', max_infrastructure_recoveries, 'maxRunInfrastructureRecoveries', max_run_infrastructure_recoveries), 'unknownRun', CASE WHEN NOT comparable THEN run_id END)::text) AS key
      FROM identified
    ), cohorts AS (
      SELECT key, jsonb_build_object(
        'key', key, 'commit', commit, 'split', split, 'inputs', resolved_inputs, 'profile', profile,
        'runtime', display_runtime, 'runtimeState', runtime_state,
        'comparable', comparable, 'partialCoverage', partial_coverage,
        'recovery', CASE WHEN max_attempts IS NOT NULL AND max_infrastructure_recoveries IS NOT NULL AND max_run_infrastructure_recoveries IS NOT NULL THEN jsonb_build_object('maxAttempts', max_attempts, 'maxInfrastructureRecoveries', max_infrastructure_recoveries, 'maxRunInfrastructureRecoveries', max_run_infrastructure_recoveries) END,
        'latestRunId', max(run_id),
        'firstObserved', min(first_at), 'lastObserved', max(last_at), 'samples', count(*),
        'firstPass', count(*) FILTER (WHERE outcome = 'first'),
        'laterPass', count(*) FILTER (WHERE outcome = 'later'),
        'applicationFailure', count(*) FILTER (WHERE outcome = 'application'),
        'interruptedApplication', count(*) FILTER (WHERE outcome = 'interrupted_application'),
        'infrastructureOnly', count(*) FILTER (WHERE outcome = 'infrastructure'),
        'unknown', count(*) FILTER (WHERE outcome = 'unknown'),
        'rawFlaky', count(*) FILTER (WHERE latest_status = 'passed' AND scenario_attempt > 1),
        'infrastructureInterruptions', sum(interruptions)
      ) AS entry
      FROM keyed GROUP BY key, commit, split, resolved_inputs, profile, display_runtime, runtime_state, comparable, partial_coverage, max_attempts, max_infrastructure_recoveries, max_run_infrastructure_recoveries
    ) SELECT entry FROM cohorts WHERE ${query.after ? sql`key > ${query.after}` : sql`true`}
    ORDER BY key LIMIT 51`)
  return ScenarioHistoryPage.parse({
    from,
    until,
    entries: rows.rows.slice(0, 50).map((r) => r.entry),
    next: rows.rows.length > 50 ? rows.rows[49]?.entry.key : null,
  })
}
