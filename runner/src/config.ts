// The only place the runner reads env (R10). Stops at startup if a value is missing or wrong.
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const Env = z.object({
  SERVER_URL: z.url(),
  RUNNER_TOKEN: z.string().min(16), // the server's RUNNER_TOKEN
  HOST: z.string().min(1), // this machine's name, as in the devices table
  TEST_ACCOUNT_PASSWORD: z.string().optional(), // shared by all test accounts in the pool
  // Folder of scenario files, inside a git checkout. Default: the samples in this repo.
  SCENARIOS_DIR: z
    .string()
    .min(1)
    .default(fileURLToPath(new URL('../../examples/scenarios', import.meta.url))),
  SCENARIO_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
})

const parsed = Env.safeParse(process.env)
if (!parsed.success) {
  console.error(`Invalid runner env:\n${z.prettifyError(parsed.error)}`)
  process.exit(1)
}
export const config = parsed.data
