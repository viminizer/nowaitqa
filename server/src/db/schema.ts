import type { Catalog } from '@nowait/shared'
import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
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

export const runs = pgTable('runs', {
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
})

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
    device: text().references(() => devices.name),
    status: text({ enum: ['passed', 'failed'] }).notNull(),
    durationMs: integer().notNull(),
    error: text(),
    screenshot: text(), // file path under ARTIFACT_DIR
    log: text(), // file path under ARTIFACT_DIR
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('results_device_idx').on(t.device, t.createdAt)], // dashboard: a phone's last work
)

// The scenario list a runner sent, per git commit of its scenario folder. Runs are filled from it.
export const catalogs = pgTable('catalogs', {
  commit: text().primaryKey(),
  scenarios: jsonb().$type<Catalog['scenarios']>().notNull(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

// Test account pool. An account is busy while the queue row it points to is leased.
// Passwords are not stored here: the runner reads them from its env.
export const accounts = pgTable('accounts', {
  username: text().primaryKey(),
  queueId: integer().references(() => queue.id),
})
