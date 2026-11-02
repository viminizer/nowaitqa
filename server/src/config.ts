// The only place the server reads env (R10). Stops at startup if a value is missing or wrong.
import { z } from 'zod'

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  // Authorization: Bearer <token>. The runner's token can do everything; the trigger token
  // (Jenkins) can only start runs and read them.
  RUNNER_TOKEN: z.string().min(16),
  TRIGGER_TOKEN: z.string().min(16),
  PORT: z.coerce.number().int().default(3000),
  LEASE_SECONDS: z.coerce.number().int().positive().default(120),
  STUCK_RUN_MINUTES: z.coerce.number().int().positive().default(15), // see expireRuns()
  MAX_ATTEMPTS: z.coerce.number().int().positive().default(2), // 1 run + 1 retry
  ARTIFACT_DIR: z.string().default('artifacts'),
  ARTIFACT_DAYS: z.coerce.number().int().positive().default(30),
})

const parsed = Env.safeParse(process.env)
if (!parsed.success) {
  console.error(`Invalid server env:\n${z.prettifyError(parsed.error)}`)
  process.exit(1)
}
export const config = parsed.data
