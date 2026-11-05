import type {
  AttemptOrigin,
  AttemptProgress,
  Catalog,
  ExecutionProfile,
  FixtureReason,
  FixtureState,
  InputRuntime,
  RecoveryAction,
  ResolvedInputs,
  RunInputIntent,
} from '@nowait/shared'
import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

export const devices = pgTable('devices', {
  name: text().primaryKey(),
  platform: text({ enum: ['android', 'ios'] }).notNull(),
  udid: text().notNull().unique(),
  appiumUrl: text().notNull(),
  systemPort: integer().notNull(),
  host: text().notNull(),
  enabled: boolean().notNull().default(true),
  platformVersion: text(),
  lastSeenAt: timestamp({ withTimezone: true }),
  pausedUntil: timestamp({ withTimezone: true }),
  pauseReason: text(),
  // Attempts leased before this time cannot count toward a new pause after recovery.
  healthSince: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

export const runs = pgTable(
  'runs',
  {
    id: serial().primaryKey(),
    platform: text({ enum: ['android', 'ios'] }).notNull(),
    appBuild: text().notNull(),
    commit: text().notNull(),
    trigger: text().notNull(),
    split: text({ enum: ['queue', 'fixed'] })
      .notNull()
      .default('queue'),
    status: text({ enum: ['running', 'passed', 'failed'] })
      .notNull()
      .default('running'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
    // Nullable policy preserves legacy runs' original total-attempt behavior.
    maxAttempts: integer(),
    maxInfrastructureRecoveries: integer(),
    maxRunInfrastructureRecoveries: integer(),
    infrastructureRecoveries: integer().notNull().default(0),
    profiles: jsonb().$type<ExecutionProfile[]>(),
    inputIntent: jsonb().$type<RunInputIntent>(),
    resolvedInputs: jsonb().$type<ResolvedInputs>(),
    expectedInputs: jsonb().$type<ResolvedInputs>(),
  },
  // notifications: finished runs by when they finished
  (t) => [
    index('runs_finished_idx').on(t.finishedAt).where(sql`status <> 'running'`), // notifications
    index('runs_created_idx').on(t.createdAt), // artifact cleanup: runs older than ARTIFACT_DAYS
    index('runs_active_idx').on(t.id).where(sql`status = 'running'`), // revision references
  ],
)

// One row per attempt of one scenario. A retry is a new row with attempt + 1 and the same slot.
export const queue = pgTable(
  'queue',
  {
    id: serial().primaryKey(),
    runId: integer()
      .notNull()
      .references(() => runs.id),
    slot: integer().notNull().default(0), // which item of the run this is (a scenario can repeat)
    scenarioId: text().notNull(),
    profile: jsonb().$type<ExecutionProfile>(),
    attempt: integer().notNull().default(1),
    scenarioAttempt: integer().notNull().default(1),
    infrastructureRecoveries: integer().notNull().default(0),
    scenarioStarted: boolean(), // true after confirmed progress; otherwise unknown until a result
    status: text({ enum: ['pending', 'leased', 'done'] })
      .notNull()
      .default('pending'),
    assignedDevice: text().references(() => devices.name), // set only when split = fixed
    // how long this scenario usually takes (queue.ts expectedTimes); null = no history yet
    expectedMs: integer(),
    device: text().references(() => devices.name), // the phone holding (or that held) the lease
    leasedAt: timestamp({ withTimezone: true }),
    leaseUntil: timestamp({ withTimezone: true }),
    cleanupPending: boolean().notNull().default(false),
    progress: jsonb().$type<AttemptProgress>(),
    inputRuntime: jsonb().$type<InputRuntime>(),
    inputsVerified: boolean().notNull().default(false),
  },
  (t) => [
    index('queue_pending_idx').on(t.runId, t.id).where(sql`status = 'pending'`),
    index('queue_run_idx').on(t.runId, t.id), // a run's attempts (dashboard, summaries)
    index('queue_slot_idx').on(t.runId, t.slot, t.attempt), // health: a failed item's later attempts
    index('queue_leased_idx').on(t.device).where(sql`status = 'leased'`), // dashboard: busy phones
    index('queue_cleanup_idx').on(t.device).where(sql`cleanup_pending`),
  ],
)

export const results = pgTable(
  'results',
  {
    id: serial().primaryKey(),
    queueId: integer()
      .notNull()
      .unique()
      .references(() => queue.id),
    runId: integer()
      .notNull()
      .references(() => runs.id),
    scenarioId: text().notNull(),
    attempt: integer().notNull(),
    platform: text({ enum: ['android', 'ios'] }).notNull(),
    device: text().references(() => devices.name),
    status: text({ enum: ['passed', 'failed'] }).notNull(),
    durationMs: integer().notNull(),
    error: text(),
    screenshot: text(), // artifact key (storage/), like "5/views.checkbox-0-1.png"
    diagnostics: text(), // bounded JSON artifact key
    log: text(), // artifact key
    phase: text().$type<AttemptOrigin['phase']>().notNull().default('unknown'),
    failureKind: text().$type<AttemptOrigin['failureKind']>().default('unknown'),
    scenarioStarted: boolean(),
    recoveryAction: text().$type<RecoveryAction>().notNull().default('none'),
    recoveryNote: text(),
    retryQueueId: integer().references(() => queue.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('results_device_idx').on(t.device, t.createdAt), // dashboard: a phone's last work
    index('results_device_passed_idx').on(t.device, t.createdAt).where(sql`status = 'passed'`), // health: the success that resets a phone's failure streak
    index('results_run_idx').on(t.runId), // a run's results (artifact cleanup)
    // expectedTimes: a scenario's latest passing attempts
    index('results_passed_idx').on(t.platform, t.scenarioId, t.id).where(sql`status = 'passed'`),
  ],
)

// The scenario list a runner sent, per git commit of its scenario folder. Runs are filled from it.
export const catalogs = pgTable('catalogs', {
  commit: text().primaryKey(),
  scenarios: jsonb().$type<Catalog['scenarios']>().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

// Which finished runs each chat platform has sent (notify/index.ts). A missing row = not sent yet.
export const notifications = pgTable(
  'notifications',
  {
    runId: integer()
      .notNull()
      .references(() => runs.id),
    notifier: text().notNull(), // Notifier.name, like 'slack'
    sentAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.notifier] })],
)

// When each chat platform was first turned on: runs that finished before are not sent.
export const notifiersOn = pgTable('notifiers_on', {
  name: text().primaryKey(), // Notifier.name
  since: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

// Test account pool. An account is busy while its queue row is leased or awaiting cleanup.
// Passwords are not stored here: the runner reads them from its env.
export const accounts = pgTable('accounts', {
  username: text().primaryKey(),
  queueId: integer().references(() => queue.id),
})

// Write-ahead resource identities only; no setup values, credentials or backend locators.
export const fixtureResources = pgTable(
  'fixture_resources',
  {
    id: serial().primaryKey(),
    queueId: integer()
      .notNull()
      .references(() => queue.id),
    key: text().notNull().unique(),
    name: text().notNull(),
    status: text().$type<FixtureState>().notNull().default('pending'),
    reason: text().$type<FixtureReason>().default('awaiting_cleanup'),
    attempts: integer().notNull().default(0),
    claim: text(),
    claimUntil: timestamp({ withTimezone: true }),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('fixture_attempt_name_idx').on(t.queueId, t.name),
    index('fixture_open_idx').on(t.id).where(sql`status <> 'cleaned'`),
    index('fixture_pending_idx').on(t.nextAttemptAt, t.id).where(sql`status <> 'cleaned'`),
    index('fixture_retention_idx').on(t.updatedAt, t.id).where(sql`status = 'cleaned'`),
  ],
)
