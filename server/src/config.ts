// The only place the server reads env (R10). Stops at startup if a value is missing or wrong.
import { z } from 'zod'

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  // Authorization: Bearer <token>. The runner's token can do everything; the trigger token
  // (Jenkins) can only start runs and read them.
  RUNNER_TOKEN: z.string().min(16),
  TRIGGER_TOKEN: z.string().min(16),
  DASHBOARD_PASSWORD: z.string().min(16), // basic auth for /dashboard, any user name
  PORT: z.coerce.number().int().default(3000),
  LEASE_SECONDS: z.coerce.number().int().positive().default(120),
  STUCK_RUN_MINUTES: z.coerce.number().int().positive().default(15), // see expireRuns()
  MAX_ATTEMPTS: z.coerce.number().int().positive().default(2), // 1 run + 1 retry
  ARTIFACT_DIR: z.string().default('artifacts'),
  ARTIFACT_DAYS: z.coerce.number().int().positive().default(30),
  // The server's address as people open it (https://qa.example.com), for links in chat messages.
  PUBLIC_URL: z.url().optional(),
  // Slack: on when both are set. A bot token (xoxb-...) with chat:write and files:write.
  SLACK_BOT_TOKEN: z.string().min(1).optional(),
  SLACK_CHANNEL: z.string().min(1).optional(), // a channel id (C0123...) or name (#qa)
  SLACK_API_URL: z.url().default('https://slack.com/api'), // tests point it at a fake Slack
  // Telegram: on when both are set. A bot in a group with topics (TELEGRAM_CHAT_ID like -100...).
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),
  TELEGRAM_RUNS_TOPIC: z.coerce.number().int().positive().optional(), // run summaries
  TELEGRAM_ERRORS_TOPIC: z.coerce.number().int().positive().optional(), // failed scenarios
  TELEGRAM_API_URL: z.url().default('https://api.telegram.org'), // tests point it at a fake API
})

const parsed = Env.refine((env) => !env.SLACK_BOT_TOKEN === !env.SLACK_CHANNEL, {
  message: 'set both SLACK_BOT_TOKEN and SLACK_CHANNEL, or neither',
  path: ['SLACK_CHANNEL'],
})
  .refine((env) => !env.TELEGRAM_BOT_TOKEN === !env.TELEGRAM_CHAT_ID, {
    message: 'set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or neither',
    path: ['TELEGRAM_CHAT_ID'],
  })
  .safeParse(process.env)
if (!parsed.success) {
  console.error(`Invalid server env:\n${z.prettifyError(parsed.error)}`)
  process.exit(1)
}
export const config = parsed.data
