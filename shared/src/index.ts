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

export const CreateRunBody = z.object({
  platform: Platform,
  appBuild: z.string().min(1), // URL or path of the APK / IPA
  commit: z.string().min(1), // git commit of the scenarios to run
  trigger: z.string().default('manual'),
})
export type CreateRunBody = z.infer<typeof CreateRunBody>

export const LeaseBody = z.object({ device: z.string().min(1) })

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

// Final status of one scenario in a run: flaky = failed first, passed on retry.
export const ScenarioStatus = z.enum(['pending', 'passed', 'flaky', 'failed'])

export const RunSummary = z.object({
  id: z.number().int(),
  platform: Platform,
  status: z.enum(['running', 'passed', 'failed']),
  createdAt: z.date(),
  finishedAt: z.date().nullable(),
  scenarios: z.array(z.object({ id: z.string(), status: ScenarioStatus })),
})
export type RunSummary = z.infer<typeof RunSummary>
