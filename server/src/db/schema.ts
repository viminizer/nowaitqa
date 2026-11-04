import type { Catalog } from '@nowait/shared'
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
} from 'drizzle-orm/pg-core'

export const devices = pgTable('devices', {
  name: text().primaryKey(),
  platform: text({ enum: ['android', 'ios'] }).notNull(),
  udid: text().notNull().unique(),
  appiumUrl: text().notNull(),
  systemPort: integer().notNull(),
  host: text().notNull(),
  enabled: boolean().notNull().default(true),
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
  },
  // notifications: finished runs by when they finished
  (t) => [
    index('runs_finished_idx').on(t.finishedAt).where(sql`status <> 'running'`), // notifications
    index('runs_created_idx').on(t.createdAt), // artifact cleanup: runs older than ARTIFACT_DAYS
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
    attempt: integer().notNull().default(1),
    status: text({ enum: ['pending', 'leased', 'done'] })
      .notNull()
      .default('pending'),
    assignedDevice: text().references(() => devices.name), // set only when split = fixed
    // how long this scenario usually takes (queue.ts expectedTimes); null = no history yet
    expectedMs: integer(),
    device: text().references(() => devices.name), // the phone holding (or that held) the lease
    leasedAt: timestamp({ withTimezone: true }),
    leaseUntil: timestamp({ withTimezone: true }),
  },
  (t) => [
    index('queue_pending_idx').on(t.runId, t.id).where(sql`status = 'pending'`),
    index('queue_run_idx').on(t.runId, t.id), // a run's attempts (dashboard, summaries)
    index('queue_leased_idx').on(t.device).where(sql`status = 'leased'`), // dashboard: busy phones
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
    log: text(), // artifact key
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('results_device_idx').on(t.device, t.createdAt), // dashboard: a phone's last work
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

// Test account pool. An account is busy while the queue row it points to is leased.
// Passwords are not stored here: the runner reads them from its env.
export const accounts = pgTable('accounts', {
  username: text().primaryKey(),
  queueId: integer().references(() => queue.id),
})
