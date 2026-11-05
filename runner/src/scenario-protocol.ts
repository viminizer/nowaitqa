// The single definition of the parent/executor IPC messages. Nothing executes on import.

import { AttemptOrigin } from '@nowait/shared'
import { z } from 'zod'

export const ScenarioCommand = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    file: z.string().min(1),
    scenarioId: z.string().min(1),
    sessionId: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    headers: z.record(z.string(), z.string()),
    capabilities: z.record(z.string(), z.unknown()),
    account: z.object({ username: z.string(), password: z.string() }).nullable(),
  }),
  z.object({ type: z.literal('stop') }),
])
export const ScenarioOutcome = z.object({
  status: z.enum(['passed', 'failed']),
  error: z.string().optional(),
  ...AttemptOrigin.shape,
})
export type ScenarioOutcome = z.infer<typeof ScenarioOutcome>
export const ScenarioReady = z.object({ type: z.literal('ready') })
export const ScenarioStarted = z.object({ type: z.literal('started') })
