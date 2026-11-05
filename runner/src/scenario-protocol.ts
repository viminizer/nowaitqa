// The single definition of the parent/executor IPC messages. Nothing executes on import.

import { AttemptOrigin, DbId, FixtureName } from '@nowait/shared'
import { z } from 'zod'

const Account = z.object({ username: z.string(), password: z.string() }).nullable()

export const ScenarioCommand = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    queueId: DbId,
    fixtureTimeoutMs: z.number().int().min(1000).max(30000),
    file: z.string().min(1),
    scenarioId: z.string().min(1),
    sessionId: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    headers: z.record(z.string(), z.string()),
    capabilities: z.record(z.string(), z.unknown()),
    account: Account,
  }),
  z.object({ type: z.literal('stop') }),
  z.object({ type: z.literal('fixture_registered'), requestId: DbId, key: z.uuid() }),
  z.object({
    type: z.literal('fixture_error'),
    requestId: DbId,
    upgradeRequired: z.boolean().default(false),
  }),
])
export const ScenarioOutcome = z.object({
  status: z.enum(['passed', 'failed']),
  error: z.string().optional(),
  ...AttemptOrigin.shape,
})
export type ScenarioOutcome = z.infer<typeof ScenarioOutcome>
export const ScenarioReady = z.object({ type: z.literal('ready') })
export const ScenarioStarted = z.object({ type: z.literal('started') })

export const FixtureRequest = z.object({
  type: z.literal('fixture'),
  requestId: DbId,
  name: FixtureName,
})
export const FixtureSetupDone = z.object({ type: z.literal('fixture_setup_done'), requestId: DbId })
export const FixtureCleanupCommand = z.object({
  queueId: DbId,
  file: z.string().min(1),
  scenarioId: z.string().min(1),
  name: FixtureName,
  key: z.uuid(),
  account: Account,
})
export const FixtureCleanupOutcome = z.object({ clean: z.boolean() })
