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

export const RuntimeVersion = z
  .string()
  .regex(/^\d+(?:\.\d+){0,2}$/, 'use an exact OS version, such as 16 or 18.5')
  .max(32)
export const VirtualDeviceClass = z.enum(['android-emulator', 'ios-simulator'])
export const ExecutionProfile = z.object({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
  deviceClass: VirtualDeviceClass,
  platformVersion: RuntimeVersion,
})
export type ExecutionProfile = z.infer<typeof ExecutionProfile>
export function virtualDeviceClass(platform: Platform, udid: string) {
  return platform === 'ios' && z.uuid().safeParse(udid).success
    ? ('ios-simulator' as const)
    : platform === 'android' && /^emulator-\d+$/.test(udid)
      ? ('android-emulator' as const)
      : null
}

const DeviceFields = z.object({
  name: z.string().min(1),
  platform: Platform,
  udid: z.string().min(1),
  appiumUrl: z.url(),
  systemPort: z.number().int().positive().max(65_535), // iOS also reserves the following port (MJPEG)
  host: z.string().min(1), // which machine the phone is plugged into
  enabled: z.boolean().default(true),
  platformVersion: RuntimeVersion.nullable().default(null),
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
export function matchesProfile(
  device: Pick<Device, 'platform' | 'udid' | 'platformVersion'>,
  profile: ExecutionProfile,
) {
  return (
    device.platformVersion === profile.platformVersion &&
    virtualDeviceClass(device.platform, device.udid) === profile.deviceClass
  )
}
// PUT /devices: without `enabled`, a new phone is on and a known one keeps its setting (the
// dashboard may have turned it off).
export const DeviceBody = DeviceFields.extend({
  enabled: z.boolean().optional(),
  platformVersion: RuntimeVersion.nullable().optional(),
}).superRefine(checkSimulator)
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
export const FullCommit = Commit.length(40)

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/)
export const ResolvedInputs = z.object({
  app: z.object({
    kind: z.enum(['archive', 'simulator-app']),
    sha256: Sha256,
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  scenarios: z.object({
    commit: FullCommit,
    tree: FullCommit,
    directory: z.string().min(1).max(4096).nullable().default(null),
    packageSha256: Sha256.nullable(),
    lockSha256: Sha256.nullable(),
    ignoredCodeSha256: Sha256.nullable().default(null),
  }),
  config: z.object({
    sessionMode: z.enum(['reuse', 'fresh']),
    scenarioTimeoutSeconds: z.number().int().positive(),
  }),
})
export type ResolvedInputs = z.infer<typeof ResolvedInputs>
export const InputRuntime = z.object({
  node: z.string().max(100),
  runner: z.string().max(100),
  webdriver: z.string().max(100),
  appium: z.string().max(100).nullable(),
  automation: z.string().max(100).nullable(),
  driver: z.string().max(100).nullable(),
  platformVersion: z.string().max(100).nullable(),
  deviceClass: VirtualDeviceClass.nullable().default(null),
})
export type InputRuntime = z.infer<typeof InputRuntime>
export const RunInputIntent = z.object({
  version: z.literal(1),
  platform: Platform,
  commit: FullCommit,
  appSource: z.string(),
  scenarios: z.array(z.string()),
  profiles: z.array(ExecutionProfile).max(10).default([]),
  split: z.enum(['queue', 'fixed']),
})
export type RunInputIntent = z.infer<typeof RunInputIntent>
export const InputManifest = z.object({
  intent: RunInputIntent.nullable(),
  expected: ResolvedInputs.nullable().default(null),
  resolved: ResolvedInputs.nullable(),
})
export const VerifyInputsBody = z.object({
  queueId: DbId,
  device: z.string().min(1),
  inputs: ResolvedInputs.extend({
    scenarios: ResolvedInputs.shape.scenarios.extend({
      ignoredCodeSha256: Sha256,
      directory: z.string().min(1).max(4096),
    }),
  }),
})
export const InputRuntimeBody = z.object({
  queueId: DbId,
  device: z.string().min(1),
  runtime: InputRuntime,
})
export const ManifestQuery = z.object({
  page: z.coerce.number().int().min(0).max(100_000).default(0),
})
export const ManifestPage = z.object({
  manifest: InputManifest,
  attempts: z.array(
    z.object({
      queueId: DbId,
      device: z.string().nullable(),
      profile: ExecutionProfile.nullable().default(null),
      runtime: InputRuntime.nullable(),
    }),
  ),
  next: z.number().int().nonnegative().nullable(),
})

// Locators may contain credentials; manifests keep only a redacted description.
export function inputSource(source: string) {
  try {
    const url = new URL(source)
    return `${url.protocol}//${url.host}/[redacted locator]`
  } catch {
    return source.includes('://') ? '[unavailable locator]' : '[Appium-host path]'
  }
}

export const RevisionQuery = z.object({ after: DbIdParam.optional() })
export const RevisionPage = z.object({
  revisions: z.array(z.object({ runId: DbId, commit: Commit, cleanupPending: z.boolean() })),
  next: DbId.nullable(),
})

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

export const RecoveryLimits = z.object({
  maxAttempts: z.number().int().positive(),
  maxInfrastructureRecoveries: z.number().int().nonnegative(),
  maxRunInfrastructureRecoveries: z.number().int().nonnegative(),
})

export const ReleasePolicy = z.enum(['permissive', 'strict'])
export type ReleasePolicy = z.infer<typeof ReleasePolicy>

export const CreateRunBody = z
  .object({
    platform: Platform,
    appBuild: z.string().min(1), // URL or Appium-host path: Android APK or iOS Simulator .app / .app.zip
    commit: Commit.optional(), // the scenarios' commit; default: the newest catalog a runner sent
    trigger: z.string().default('manual'),
    releasePolicy: ReleasePolicy.default('permissive'),
    // queue = any free phone takes the next scenario. fixed = each phone gets its list up front
    // (the old way, kept to compare against in the benchmark).
    split: z.enum(['queue', 'fixed']).default('queue'),
    repeat: z.number().int().min(1).max(20).default(1), // put every scenario in the run N times
    profiles: z.array(ExecutionProfile).max(10).default([]),
  })
  .superRefine((body, ctx) => {
    if (new Set(body.profiles.map((p) => p.name)).size !== body.profiles.length)
      ctx.addIssue({ code: 'custom', path: ['profiles'], message: 'profile names must be unique' })
    if (
      body.profiles.some(
        (p) =>
          p.deviceClass !== (body.platform === 'android' ? 'android-emulator' : 'ios-simulator'),
      )
    )
      ctx.addIssue({
        code: 'custom',
        path: ['profiles'],
        message: 'profiles must match the run platform',
      })
  })
export type CreateRunBody = z.infer<typeof CreateRunBody>

export const MAX_ATTEMPT_FIXTURES = 20
export const FIXTURE_CLAIM_SECONDS = 180 // covers preparation +30s cleanup + process stop5s + finish HTTP10s
export const FixtureName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/)
export const FixtureState = z.enum(['pending', 'cleaning', 'quarantined', 'cleaned'])
export type FixtureState = z.infer<typeof FixtureState>
export const FixtureReason = z.enum([
  'awaiting_cleanup',
  'execution_unconfirmed',
  'cleanup_failed',
  'adapter_unavailable',
  'executor_unconfirmed',
  'cleanup_owner_lost',
  'cleanup_dependency',
])
export type FixtureReason = z.infer<typeof FixtureReason>
export const FixtureRegisterBody = z.object({
  queueId: DbId,
  device: z.string().min(1),
  name: FixtureName,
})
export type FixtureRegisterBody = z.infer<typeof FixtureRegisterBody>
export const FixtureKey = z.object({ key: z.uuid() })
export const FixtureClaimBody = DeviceContactBody
export type FixtureClaimBody = z.infer<typeof FixtureClaimBody>
export const FixtureJob = z.object({
  id: DbId,
  key: z.uuid(),
  name: FixtureName,
  claim: z.uuid(),
  queueId: DbId,
  runId: DbId,
  commit: FullCommit,
  scenarioId: z.string(),
  scenarios: ResolvedInputs.shape.scenarios,
  config: ResolvedInputs.shape.config,
  account: z.string().nullable(),
})
export type FixtureJob = z.infer<typeof FixtureJob>
export const FixtureFinishBody = z
  .object({
    id: DbId,
    device: z.string().min(1),
    claim: z.uuid(),
    clean: z.boolean(),
    stopped: z.boolean(),
    reason: FixtureReason.optional(),
  })
  .refine((r) => !r.clean || r.stopped, 'verified cleanup requires confirmed executor stop')
export type FixtureFinishBody = z.infer<typeof FixtureFinishBody>
export const FixtureQuery = z.object({ after: DbIdParam.optional(), queueId: DbIdParam.optional() })
export const FixtureRetryBody = z.object({ confirmedStopped: z.literal(true) })
export const FixturePage = z.object({
  fixtures: z
    .array(
      z.object({
        id: DbId,
        key: z.uuid(),
        name: FixtureName,
        queueId: DbId,
        runId: DbId,
        scenarioId: z.string(),
        device: z.string().nullable(),
        status: FixtureState,
        reason: FixtureReason.nullable(),
        attempts: z.number().int().nonnegative().max(10),
        updatedAt: z.coerce.date(),
        canRetry: z.boolean(),
        accountHeld: z.boolean(),
      }),
    )
    .max(50),
  next: DbId.nullable(),
})
export type FixturePage = z.infer<typeof FixturePage>
export const FixtureCleanupState = z.enum(['none', 'pending', 'quarantined', 'cleaned'])
export function fixtureReasonText(reason: FixtureReason | null) {
  return reason
    ? {
        awaiting_cleanup: 'Waiting for cleanup',
        cleanup_dependency: 'Waiting for a later fixture to be cleaned',
        execution_unconfirmed: 'Previous execution has not been confirmed stopped',
        cleanup_failed: 'Cleanup did not verify absence',
        adapter_unavailable: 'Pinned fixture code is unavailable or changed',
        executor_unconfirmed: 'Cleanup process has not been confirmed stopped',
        cleanup_owner_lost: 'Cleanup stopped reporting; confirmation is required',
      }[reason]
    : ''
}

// commits: the runner's pinned, ready scenario revisions; the phone only gets work on them.
// runId: the run the phone has a session for. That run's work comes first, so the phone does not
// switch apps back and forth between runs.
export const LeaseBody = z.object({
  device: z.string().min(1),
  commits: z.array(Commit).min(1),
  runId: DbId.optional(),
  cleanup: z.boolean().default(false), // upgraded runners acknowledge stopped execution
  inputs: z.boolean().default(false), // upgraded runners verify immutable run inputs
  profiles: z.boolean().default(false), // upgraded runners verify actual runtime coverage
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
  inputProtocol: z.literal(1).optional(),
  inputIntent: RunInputIntent.nullable().default(null),
  expectedInputs: ResolvedInputs.nullable().default(null),
  profile: ExecutionProfile.nullable().default(null),
  profileProtocol: z.literal(1).optional(),
  fixtureProtocol: z.literal(1).optional(),
  deviceIdentity: DeviceFields.pick({
    udid: true,
    platform: true,
    host: true,
    appiumUrl: true,
    systemPort: true,
  })
    .nullable()
    .default(null),
})
export type Lease = z.infer<typeof Lease>

export const HeartbeatBody = z.object({
  queueId: DbId,
  device: z.string().min(1),
  // Only positive progress is persisted; no progress after a lost worker means unknown.
  scenarioStarted: z.literal(true).optional(),
})

export const AttemptPhase = z.enum(['setup', 'scenario', 'cleanup', 'queue', 'unknown'])
export const FailureKind = z.enum([
  'assertion',
  'scenario_error',
  'timeout',
  'session_unavailable',
  'executor_error',
  'lease_lost',
  'cancelled',
  'run_stuck',
  'unknown',
])
export type FailureKind = z.infer<typeof FailureKind>
export const AttemptOrigin = z.object({
  phase: AttemptPhase.default('unknown'),
  failureKind: FailureKind.nullable().default(null),
  scenarioStarted: z.boolean().nullable().default(null),
})
export type AttemptOrigin = z.infer<typeof AttemptOrigin>
export const RecoveryAction = z.enum([
  'none',
  'scenario_retry',
  'infrastructure_retry',
  'scenario_exhausted',
  'infrastructure_exhausted',
])
export type RecoveryAction = z.infer<typeof RecoveryAction>

// Shared by the attempt table and both chat platforms. Unknown is not evidence of no execution.
export function originText(origin: AttemptOrigin) {
  const execution =
    origin.scenarioStarted === null
      ? 'execution unknown'
      : origin.scenarioStarted
        ? 'scenario ran'
        : 'scenario did not start'
  return [origin.phase, origin.failureKind?.replaceAll('_', ' '), execution]
    .filter(Boolean)
    .join(' · ')
}

// A paused worker closes its idle Appium session before waiting, then leases again.
export const DevicePause = z.object({
  error: z.literal('device is paused'),
  retryAfterSeconds: z.number().int().positive().max(86_400),
})

// Diagnostic histories are snapshots, bounded even for a long or command-heavy attempt.
export const AttemptStage = z.enum([
  'app_staging',
  'session_start',
  'session_reset',
  'executor_start',
  'scenario',
  'evidence',
  'cleanup',
  'finished',
])
export type AttemptStage = z.infer<typeof AttemptStage>
export const CommandTiming = z.object({
  id: DbId,
  command: z.enum([
    'session_create',
    'session_delete',
    'screenshot',
    'source',
    'device_logs',
    'appium_events',
    'find_element',
    'click',
    'set_value',
    'execute',
    'other',
  ]),
  startedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative().max(INT4_MAX),
  status: z.enum(['running', 'passed', 'failed', 'interrupted']),
  httpStatus: z.number().int().min(100).max(599).optional(),
})
export type CommandTiming = z.infer<typeof CommandTiming>
export const AttemptProgress = z.object({
  revision: DbId,
  stage: AttemptStage,
  updatedAt: z.iso.datetime(),
  events: z.array(z.object({ id: DbId, stage: AttemptStage, at: z.iso.datetime() })).max(80),
  commands: z.array(CommandTiming).max(80),
  droppedEvents: z.number().int().nonnegative().max(INT4_MAX),
  droppedCommands: z.number().int().nonnegative().max(INT4_MAX),
})
export type AttemptProgress = z.infer<typeof AttemptProgress>
export const ProgressBody = z.object({
  queueId: DbId,
  device: z.string().min(1),
  progress: AttemptProgress,
})
export type ProgressBody = z.infer<typeof ProgressBody>
export const AttemptDiagnostics = z.object({
  version: z.literal(1),
  progress: AttemptProgress,
  sessionId: z.string().max(200).nullable(),
  error: z.string().max(8192).nullable(),
  runtime: InputRuntime.nullable(),
  config: ResolvedInputs.shape.config,
  deviceLog: z.string().max(65536).nullable(),
  hierarchy: z.string().max(65536).nullable(),
  appiumEvents: z
    .array(
      z.object({
        command: CommandTiming.shape.command,
        startedAt: z.number().finite(),
        durationMs: z.number().nonnegative().finite(),
      }),
    )
    .max(80),
  missing: z
    .array(
      z.object({
        item: z.enum(['screenshot', 'device_log', 'hierarchy', 'appium_events', 'appium_host_log']),
        reason: z.string().max(200),
      }),
    )
    .max(5),
})
export type AttemptDiagnostics = z.infer<typeof AttemptDiagnostics>
export const DiagnosticDownload = z.object({
  fixtures: z.string().nullable().default(null),
  commit: z.string(),
  inputs: InputManifest.omit({ intent: true }),
  runtime: InputRuntime.nullable(),
  queueId: DbId,
  runId: DbId,
  scenarioId: z.string(),
  attempt: DbId,
  device: z.string().nullable(),
  profile: ExecutionProfile.nullable(),
  origin: AttemptOrigin.nullable(),
  progress: AttemptProgress.nullable(),
  diagnostics: AttemptDiagnostics.nullable(),
  missing: z.string().nullable(),
  screenshot: z.string().nullable(),
  log: z.string().nullable(),
})
export function stageText(stage: AttemptStage) {
  return {
    app_staging: 'App preparation',
    session_start: 'Session preparation',
    session_reset: 'Session reset',
    executor_start: 'Executor startup',
    scenario: 'Scenario execution',
    evidence: 'Evidence collection',
    cleanup: 'Cleanup',
    finished: 'Finished',
  }[stage]
}

export const ResultBody = z
  .object({
    queueId: DbId,
    device: z.string().min(1),
    status: z.enum(['passed', 'failed']),
    durationMs: z.number().int().nonnegative().max(INT4_MAX),
    error: z.string().optional(),
    diagnostics: AttemptDiagnostics.optional(),
    screenshot: z.base64().optional(), // PNG, as WebdriverIO's takeScreenshot() returns it
    log: z.string().optional(),
    cleanupComplete: z.boolean().optional(),
    phase: AttemptPhase.optional(),
    failureKind: FailureKind.nullable().optional(),
    scenarioStarted: z.boolean().optional(),
  })
  .superRefine((body, ctx) => {
    if (body.status === 'passed' && body.failureKind != null)
      ctx.addIssue({
        code: 'custom',
        path: ['failureKind'],
        message: 'a passed attempt has no failure kind',
      })
    if (
      body.failureKind === 'session_unavailable' &&
      (body.phase !== 'setup' || body.scenarioStarted !== false || body.status !== 'failed')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['failureKind'],
        message: 'session_unavailable requires a failed setup before scenario execution',
      })
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

export const ReleaseGate = z.object({
  policy: ReleasePolicy,
  status: z.enum(['pending', 'accepted', 'rejected']),
  reason: z.enum([
    'running',
    'accepted',
    'failed_scenarios',
    'flaky_scenarios',
    'missing_coverage',
    'decision_unavailable',
  ]),
  counts: z.object({
    pending: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    flaky: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
})
export type ReleaseGate = z.infer<typeof ReleaseGate>
export const ReleaseReport = z.object({
  gate: ReleaseGate,
  source: z.enum(['saved', 'legacy']),
  partialCoverage: z.boolean(),
  rerunOf: DbId.nullable(),
})
export function evaluateReleaseGate(
  policy: ReleasePolicy,
  status: 'running' | 'passed' | 'failed',
  counts: ReturnType<typeof countStatuses>,
  completeCoverage: boolean,
): ReleaseGate {
  const reason =
    status === 'running'
      ? 'running'
      : !completeCoverage || Object.values(counts).reduce((n, c) => n + c, 0) === 0
        ? 'missing_coverage'
        : status === 'failed' || counts.failed > 0 || counts.pending > 0
          ? 'failed_scenarios'
          : policy === 'strict' && counts.flaky > 0
            ? 'flaky_scenarios'
            : 'accepted'
  return {
    policy,
    status: reason === 'running' ? 'pending' : reason === 'accepted' ? 'accepted' : 'rejected',
    reason,
    counts,
  }
}
export function releaseReasonText(reason: ReleaseGate['reason']) {
  return {
    running: 'Awaiting completed execution',
    accepted: 'Release policy satisfied',
    failed_scenarios: 'Required scenarios did not pass',
    flaky_scenarios: 'Strict policy rejects later-pass recovery',
    missing_coverage: 'Full required coverage is missing',
    decision_unavailable: 'Saved release decision is unavailable',
  }[reason]
}

export const RunSummary = z.object({
  release: ReleaseReport.nullable().default(null),
  id: z.number().int(),
  platform: Platform,
  appBuild: z.string(),
  commit: z.string(),
  trigger: z.string(),
  inputManifest: InputManifest.default({ intent: null, expected: null, resolved: null }),
  profiles: z.array(ExecutionProfile).default([]),
  coverage: z
    .array(
      z.object({
        profile: ExecutionProfile,
        counts: z.record(ScenarioStatus, z.number().int()),
        availability: z.enum(['available', 'no_matching_device']),
      }),
    )
    .default([]),
  split: z.enum(['queue', 'fixed']),
  status: z.enum(['running', 'passed', 'failed']),
  createdAt: z.coerce.date(),
  finishedAt: z.coerce.date().nullable(),
  durationMs: z.number().int().nullable(), // created -> finished
  // null for legacy runs; new runs retain their effective retry policy across server restarts.
  recovery: z
    .object({
      ...RecoveryLimits.shape,
      infrastructureRecoveries: z.number().int().nonnegative(),
    })
    .nullable()
    .default(null),
  scenarios: z.array(
    z.object({
      id: z.string(),
      profile: ExecutionProfile.nullable().default(null),
      status: ScenarioStatus,
      origin: AttemptOrigin.nullable().default(null),
    }),
  ),
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
    RunSummary.omit({
      scenarios: true,
      devices: true,
      inputManifest: true,
      profiles: true,
      coverage: true,
    }).extend({
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
  profile: ExecutionProfile.nullable().default(null),
  attempt: z.number().int(),
  scenarioAttempt: z.number().int().positive().nullable().default(null),
  infrastructureRecoveries: z.number().int().nonnegative().default(0),
  device: z.string().nullable(),
  status: z.enum(['pending', 'leased', 'passed', 'failed']),
  leasedAt: z.coerce.date().nullable(),
  finishedAt: z.coerce.date().nullable(),
  durationMs: z.number().int().nullable(),
  error: z.string().nullable(),
  inputRuntime: InputRuntime.nullable().default(null),
  inputsVerified: z.boolean().default(false),
  progress: AttemptProgress.nullable().default(null),
  diagnostics: z.boolean().default(false),
  fixtureCleanup: FixtureCleanupState.default('none'),
  screenshot: z.boolean(), // a file is saved; get it from the dashboard files route
  log: z.boolean(),
  ...AttemptOrigin.shape,
  recoveryAction: RecoveryAction.default('none'),
  recoveryNote: z.string().nullable().default(null),
  retryQueueId: DbId.nullable().default(null),
})
export type Attempt = z.infer<typeof Attempt>

// One block of a run's timeline: the time a phone spent on one attempt.
export const TimelineBlock = Attempt.pick({
  queueId: true,
  scenarioId: true,
  profile: true,
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
        .object({
          queueId: DbId,
          runId: DbId,
          scenarioId: z.string(),
          fixtureState: FixtureState.nullable().default(null),
        })
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

export const ScenarioHistoryQuery = z.object({
  scenarioId: z.string().min(1).max(4096),
  platform: Platform,
  days: z.coerce
    .number()
    .pipe(z.union([z.literal(7), z.literal(30), z.literal(90)]))
    .default(30),
  until: z.iso
    .datetime({ offset: true })
    .refine((v) => new Date(v).getTime() >= 0, 'until must be 1970 or later')
    .optional(),
  after: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
})
export type ScenarioHistoryQuery = z.infer<typeof ScenarioHistoryQuery>
const HistoryCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const ScenarioHistoryPage = z.object({
  from: z.coerce.date(),
  until: z.coerce.date(),
  entries: z
    .array(
      z.object({
        key: z.string().regex(/^[a-f0-9]{32}$/),
        commit: z.string(),
        split: z.enum(['queue', 'fixed']),
        inputs: ResolvedInputs.nullable(),
        profile: ExecutionProfile.nullable(),
        runtime: InputRuntime.nullable(),
        runtimeState: z.enum(['verified', 'mixed', 'unknown']),
        comparable: z.boolean(),
        recovery: RecoveryLimits.nullable(),
        partialCoverage: z.boolean(),
        latestRunId: DbId,
        firstObserved: z.coerce.date(),
        lastObserved: z.coerce.date(),
        samples: HistoryCount,
        firstPass: HistoryCount,
        laterPass: HistoryCount,
        applicationFailure: HistoryCount,
        interruptedApplication: HistoryCount,
        infrastructureOnly: HistoryCount,
        unknown: HistoryCount,
        infrastructureInterruptions: HistoryCount,
        rawFlaky: HistoryCount,
      }),
    )
    .max(50),
  next: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .nullable(),
})
export type ScenarioHistoryPage = z.infer<typeof ScenarioHistoryPage>
