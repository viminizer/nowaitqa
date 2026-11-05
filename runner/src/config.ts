// The only place the runner reads env (R10). Stops at startup if a value is missing or wrong.
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

if (process.platform === 'win32') {
  console.error(
    'Isolated scenario execution requires a macOS or Linux runner (POSIX process groups)',
  )
  process.exit(1)
}

const Env = z.object({
  SERVER_URL: z.url(),
  RUNNER_TOKEN: z.string().min(16), // the server's RUNNER_TOKEN
  HOST: z.string().min(1), // this machine's name, as in the devices table
  TEST_ACCOUNT_PASSWORD: z.string().optional(), // shared by all test accounts in the pool
  // Folder of scenario files, inside a git checkout. Default: the samples in this repo.
  // With SCENARIOS_REPO: the folder the runner clones into and manages (must be set).
  SCENARIOS_DIR: z
    .string()
    .min(1)
    .default(fileURLToPath(new URL('../../examples/scenarios', import.meta.url))),
  SCENARIOS_REPO: z.string().min(1).optional(), // git URL the runner pulls every minute
  SCENARIOS_BRANCH: z.string().min(1).default('main'),
  SCENARIO_CACHE_REVISIONS: z.coerce.number().int().min(2).max(100).default(10),
  SCENARIO_CACHE_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .max(Number.MAX_SAFE_INTEGER)
    .default(5 * 1024 ** 3),
  SCENARIO_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  SESSION_MODE: z.enum(['reuse', 'fresh']).default('reuse'),
})

const parsed = Env.refine((env) => !env.SCENARIOS_REPO || process.env.SCENARIOS_DIR, {
  message: 'set SCENARIOS_DIR: the folder to clone SCENARIOS_REPO into',
  path: ['SCENARIOS_DIR'],
}).safeParse(process.env)
if (!parsed.success) {
  console.error(`Invalid runner env:\n${z.prettifyError(parsed.error)}`)
  process.exit(1)
}
export const config = parsed.data
