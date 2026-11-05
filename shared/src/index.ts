// API contract between the server, the runner and Jenkins. Both sides import these schemas (R5).
import { z } from 'zod'

export { every } from './jobs.ts'

// Worker contact is independent of leases, including idle work and health pauses.
export const DEVICE_CONTACT_INTERVAL_MS = 30_000
export const DEVICE_CONTACT_TIMEOUT_MS = 10_000

// A row id from the request. Postgres ids and ints are 4 bytes: a bigger number is a 400 here, not
// a 500 from the database (R47).
const INT4_MAX = 2_147_483_647
export const DbId = z.number().int().positive().max(INT4_MAX)
// the same, from a URL path or query: digits only, so one row has one URL (not 0x10 or 1e1)
export const DbIdParam = z
  .string()
  .regex(/^\d+$/, 'must be a whole number')
  .transform(Number)
  .pipe(DbId)

export const Platform = z.enum(['android', 'ios'])
export type Platform = z.infer<typeof Platform>

const DeviceFields = z.object({
  name: z.string().min(1),
  platform: Platform,
  udid: z.string().min(1),
  appiumUrl: z.url(),
  systemPort: z.number().int().positive().max(65_535), // iOS also reserves the following port (MJPEG)
  host: z.string().min(1), // which machine the phone is plugged into
  enabled: z.boolean().default(true),
})

function checkSimulator(
  device: { platform: string; udid: string; systemPort: number },
  ctx: z.RefinementCtx,
) {
  if (device.platform !== 'ios') return
  if (!z.uuid().safeParse(device.udid).success) {
    ctx.addIssue({ code: 'custom', path: ['udid'], message: 'iOS requires a Simulator UUID' })
  }
  if (device.systemPort === 65_535) {
    ctx.addIssue({
      code: 'custom',
      path: ['systemPort'],
      message: 'iOS needs this port and the next one',
    })
  }
}
export const Device = DeviceFields.superRefine(checkSimulator)
export type Device = z.infer<typeof Device>
// PUT /devices: without `enabled`, a new phone is on and a known one keeps its setting (the
// dashboard may have turned it off).
export const DeviceBody = DeviceFields.extend({ enabled: z.boolean().optional() }).superRefine(
  checkSimulator,
)
export type DeviceBody = z.infer<typeof DeviceBody>

export const DeviceContactBody = DeviceFields.pick({
  name: true,
  host: true,
  udid: true,
  platform: true,
})
export type DeviceContactBody = z.infer<typeof DeviceContactBody>
export const DeviceConnectivity = z.enum(['waiting', 'online', 'offline'])
export type DeviceConnectivity = z.infer<typeof DeviceConnectivity>

// A git commit, full or short. Hex only, so it is safe in a LIKE pattern.
const Commit = z.string().regex(/^[0-9a-f]{4,40}$/, 'must be a git commit hash')

// The scenarios a runner has, and the git commit of its scenario folder. Sent when it starts.
export const Catalog = z.object({
  commit: Commit,
  scenarios: z.array(
    z.object({
      // part of artifact file names and keys, so no / or \
      id: z.string().regex(/^[^/\\]+$/, 'must not contain / or \\'),
      platforms: z.array(Platform).min(1),
    }),
  ),
})
export type Catalog = z.infer<typeof Catalog>

export const CreateRunBody = z.object({
  platform: Platform,
  appBuild: z.string().min(1), // URL or Appium-host path: Android APK or iOS Simulator .app / .app.zip
  commit: Commit.optional(), // the scenarios' commit; default: the newest catalog a runner sent
  trigger: z.string().default('manual'),
  // queue = any free phone takes the next scenario. fixed = each phone gets its list up front
  // (the old way, kept to compare against in the benchmark).
  split: z.enum(['queue', 'fixed']).default('queue'),
  repeat: z.number().int().min(1).max(20).default(1), // put every scenario in the run N times
})
export type CreateRunBody = z.infer<typeof CreateRunBody>

// commits: the runner's scenario commits (newest, and the one before a pull); the phone only gets
// work from runs on them.
// runId: the run the phone has a session for. That run's work comes first, so the phone does not
// switch apps back and forth between runs.
export const LeaseBody = z.object({
  device: z.string().min(1),
  commits: z.array(Commit).min(1),
  runId: DbId.optional(),
  cleanup: z.boolean().default(false), // upgraded runners acknowledge stopped execution
})

export const Lease = z.object({
  queueId: z.number().int(),
  runId: z.number().int(),
  appBuild: z.string(),
  commit: z.string(),
  scenarioId: z.string(),
  attempt: z.number().int(),
  account: z.string().nullable(), // test account username; the password comes from runner env
  leaseSeconds: z.number().int(),
  sessionResetAt: z.coerce.date(), // new session required when this marker changes after a health pause
  cleanupRequired: z.boolean().default(false),
})
export type Lease = z.infer<typeof Lease>

export const HeartbeatBody = z.object({ queueId: DbId, device: z.string().min(1) })

// A paused worker closes its idle Appium session before waiting, then leases again.
export const DevicePause = z.object({
  error: z.literal('device is paused'),
  retryAfterSeconds: z.number().int().positive().max(86_400),
})

export const ResultBody = z.object({
  queueId: DbId,
  device: z.string().min(1),
  status: z.enum(['passed', 'failed']),
  durationMs: z.number().int().nonnegative().max(INT4_MAX),
  error: z.string().optional(),
  screenshot: z.base64().optional(), // PNG, as WebdriverIO's takeScreenshot() returns it
  log: z.string().optional(),
  cleanupComplete: z.boolean().optional(),
})
export type ResultBody = z.infer<typeof ResultBody>

// Every error response.
export const ApiError = z.object({ error: z.string() })

// Final status of one scenario in a run: flaky = failed first, passed on retry.
export const ScenarioStatus = z.enum(['pending', 'passed', 'flaky', 'failed'])
export type ScenarioStatus = z.infer<typeof ScenarioStatus>

// The text of anything thrown: an Error's message, or its name or code when the message is empty
// (some S3 SDK errors have none), or the value itself (a string, an object).
export function messageOf(err: unknown) {
  if (!(err instanceof Error)) return String(err)
  return err.message || (err as { code?: string }).code || err.name
}

// "45s" or "3m 12s". The dashboard and the chat messages both use it.
export function formatDuration(ms: number) {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

// How many scenarios have each status. The runs list (server) and a run's page (web) both use it.
export function countStatuses(statuses: ScenarioStatus[]) {
  const counts = { pending: 0, passed: 0, flaky: 0, failed: 0 }
  for (const status of statuses) counts[status]++
  return counts
}

export const RunSummary = z.object({
  id: z.number().int(),
  platform: Platform,
  appBuild: z.string(),
  commit: z.string(),
  trigger: z.string(),
  split: z.enum(['queue', 'fixed']),
  status: z.enum(['running', 'passed', 'failed']),
  createdAt: z.coerce.date(),
  finishedAt: z.coerce.date().nullable(),
  durationMs: z.number().int().nullable(), // created -> finished
  scenarios: z.array(z.object({ id: z.string(), status: ScenarioStatus })),
  // Per phone: busy = holding a lease (install, reset, run). idle = the rest of the run.
  devices: z.array(
    z.object({
      name: z.string(),
      attempts: z.number().int(),
      busyMs: z.number().int(),
      idleMs: z.number().int().nullable(),
    }),
  ),
})
export type RunSummary = z.infer<typeof RunSummary>

// --- dashboard (read-only) ---

// A page of runs, newest first. older: the `before` value for the next page, or null on the last.
export const RunList = z.object({
  older: z.number().int().nullable(),
  runs: z.array(
    RunSummary.omit({ scenarios: true, devices: true }).extend({
      counts: z.record(ScenarioStatus, z.number().int()), // countStatuses() of its scenarios
    }),
  ),
})
export type RunList = z.infer<typeof RunList>

// One attempt of one scenario. leasedAt -> finishedAt is the time a phone spent on it.
export const Attempt = z.object({
  queueId: z.number().int(),
  slot: z.number().int(),
  scenarioId: z.string(),
  attempt: z.number().int(),
  device: z.string().nullable(),
  status: z.enum(['pending', 'leased', 'passed', 'failed']),
  leasedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
  durationMs: z.number().int().nullable(),
  error: z.string().nullable(),
  screenshot: z.boolean(), // a file is saved; get it from the dashboard files route
  log: z.boolean(),
})
export type Attempt = z.infer<typeof Attempt>

// One block of a run's timeline: the time a phone spent on one attempt.
export const TimelineBlock = Attempt.pick({
  queueId: true,
  scenarioId: true,
  attempt: true,
  device: true,
  status: true,
  leasedAt: true,
  finishedAt: true,
})

// A run for its dashboard page. now: the database clock, the same one as every timestamp, so a
// running run's timeline never mixes clocks. timeline: the first TIMELINE_LIMIT blocks in the order
// phones took them; timelineCut says there were more.
export const RunDetail = RunSummary.extend({
  now: z.coerce.date(),
  timeline: z.array(TimelineBlock),
  timelineCut: z.boolean(),
})
export type RunDetail = z.infer<typeof RunDetail>

// One page of a run's attempts, failures first. next: the next page number, or null on the last.
// runStatus: the page polls itself until the run is over, so its last read has the final results.
export const AttemptPage = z.object({
  attempts: z.array(Attempt),
  next: z.number().int().nullable(),
  runStatus: RunSummary.shape.status,
})
export type AttemptPage = z.infer<typeof AttemptPage>

// A phone and what it does now. busy: the attempt it holds a lease for.
export const DeviceList = z.object({
  devices: z.array(
    Device.safeExtend({
      connectivity: DeviceConnectivity,
      lastSeenAt: z.coerce.date().nullable(),
      busy: z.object({ runId: z.number().int(), scenarioId: z.string() }).nullable(),
      lastWorkAt: z.coerce.date().nullable(), // when it last finished an attempt
      pausedUntil: z.coerce.date().nullable(), // null when the cooldown is over, by the server's clock
      pauseReason: z.string().nullable(),
      cleanup: z
        .object({ queueId: DbId, runId: DbId, scenarioId: z.string() })
        .nullable()
        .default(null),
    }),
  ),
})
export type DeviceList = z.infer<typeof DeviceList>

// --- dashboard actions ---

// A new run's id (POST /runs, and "run again" on the dashboard).
export const CreatedRun = z.object({ id: DbId })

// Turn a phone on or off. A phone that is off takes no new work.
export const DeviceEnabledBody = z.object({ enabled: z.boolean() })

// Run a finished run again: all its scenarios, or only the failed ones.
export const RunAgainBody = z.object({ failedOnly: z.boolean() })

// Dashboard actions must send this header. Another site's page can't add it without asking the
// server first (CORS), so it can't use the password the browser keeps.
export const ACTION_HEADER = 'x-nowait-action'
