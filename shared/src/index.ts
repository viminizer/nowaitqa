// API contract between the server, the runner and Jenkins. Both sides import these schemas (R5).
import { z } from 'zod'

export const Platform = z.enum(['android', 'ios'])
export type Platform = z.infer<typeof Platform>

export const Device = z.object({
  name: z.string().min(1),
  platform: Platform,
  udid: z.string().min(1),
  appiumUrl: z.url(),
  systemPort: z.number().int().positive(), // systemPort (Android) or wdaLocalPort (iOS)
  host: z.string().min(1), // which machine the phone is plugged into
  enabled: z.boolean().default(true),
})
export type Device = z.infer<typeof Device>

// A git commit, full or short. Hex only, so it is safe in a LIKE pattern.
const Commit = z.string().regex(/^[0-9a-f]{4,40}$/, 'must be a git commit hash')

// The scenarios a runner has, and the git commit of its scenario folder. Sent when it starts.
export const Catalog = z.object({
  commit: Commit,
  scenarios: z.array(z.object({ id: z.string().min(1), platforms: z.array(Platform).min(1) })),
})
export type Catalog = z.infer<typeof Catalog>

export const CreateRunBody = z.object({
  platform: Platform,
  appBuild: z.string().min(1), // URL or path of the APK / IPA
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
  runId: z.number().int().optional(),
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
})
export type Lease = z.infer<typeof Lease>

export const HeartbeatBody = z.object({ queueId: z.number().int(), device: z.string().min(1) })

export const ResultBody = z.object({
  queueId: z.number().int(),
  device: z.string().min(1),
  status: z.enum(['passed', 'failed']),
  durationMs: z.number().int().nonnegative(),
  error: z.string().optional(),
  screenshot: z.base64().optional(), // PNG, as WebdriverIO's takeScreenshot() returns it
  log: z.string().optional(),
})
export type ResultBody = z.infer<typeof ResultBody>

// Every error response.
export const ApiError = z.object({ error: z.string() })

// Final status of one scenario in a run: flaky = failed first, passed on retry.
export const ScenarioStatus = z.enum(['pending', 'passed', 'flaky', 'failed'])

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
  counts: z.record(ScenarioStatus, z.number().int()), // how many scenarios have each status
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
  runs: z.array(RunSummary.omit({ scenarios: true, devices: true })),
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

// now: the server's clock, so a running run's timeline never mixes it with the browser's.
export const RunDetail = RunSummary.extend({ attempts: z.array(Attempt), now: z.coerce.date() })
export type RunDetail = z.infer<typeof RunDetail>

// A phone and what it does now. busy: the attempt it holds a lease for.
export const DeviceList = z.object({
  devices: z.array(
    Device.extend({
      busy: z.object({ runId: z.number().int(), scenarioId: z.string() }).nullable(),
      lastWorkAt: z.coerce.date().nullable(), // when it last finished an attempt
    }),
  ),
})
export type DeviceList = z.infer<typeof DeviceList>
