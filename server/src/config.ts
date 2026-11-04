// The only place the server reads env (R10). Stops at startup if a value is missing or wrong.
import { z } from 'zod'

// An optional setting: an empty value (FOO= in a compose file) counts as not set.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional())

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
  // Greater than the worker's 30s contact interval plus its 10s request timeout (R34).
  DEVICE_OFFLINE_SECONDS: z.coerce.number().int().min(60).max(86_400).default(120),
  // Suspected unhealthy phones take no new work for this long, then resume automatically.
  DEVICE_PAUSE_SECONDS: z.coerce.number().int().positive().max(86_400).default(300),
  ARTIFACT_DIR: z.string().default('artifacts'), // where artifacts go when S3_BUCKET is not set
  ARTIFACT_DAYS: z.coerce.number().int().positive().default(30),
  // S3 for artifacts: on when S3_BUCKET is set. S3_ENDPOINT for RustFS or MinIO (like
  // http://localhost:9000); without keys, the SDK finds credentials itself (an IAM role on AWS).
  S3_BUCKET: optional(z.string()),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ENDPOINT: optional(z.url()),
  S3_ACCESS_KEY_ID: optional(z.string()),
  S3_SECRET_ACCESS_KEY: optional(z.string()),
  // The server's address as people open it (https://qa.example.com), for links in chat messages.
  PUBLIC_URL: optional(z.url()),
  // Slack: on when both are set. A bot token (xoxb-...) with chat:write and files:write.
  SLACK_BOT_TOKEN: optional(z.string()),
  SLACK_CHANNEL: optional(z.string()), // a channel id (C0123...) or name (#qa)
  SLACK_API_URL: z.url().default('https://slack.com/api'), // or https://slack-gov.com/api
  // Telegram: on when both are set. A bot in a group with topics (TELEGRAM_CHAT_ID like -100...).
  TELEGRAM_BOT_TOKEN: optional(z.string()),
  TELEGRAM_CHAT_ID: optional(z.string()),
  TELEGRAM_RUNS_TOPIC: optional(z.coerce.number().int().positive()), // run summaries
  TELEGRAM_ERRORS_TOPIC: optional(z.coerce.number().int().positive()), // failed scenarios
  TELEGRAM_API_URL: z.url().default('https://api.telegram.org'), // or a self-hosted Bot API
})

const parsed = Env.refine((env) => env.DEVICE_PAUSE_SECONDS < env.STUCK_RUN_MINUTES * 60, {
  message:
    'DEVICE_PAUSE_SECONDS must be shorter than STUCK_RUN_MINUTES, so paused phones can recover',
  path: ['DEVICE_PAUSE_SECONDS'],
})
  .refine((env) => !env.SLACK_BOT_TOKEN === !env.SLACK_CHANNEL, {
    message: 'set both SLACK_BOT_TOKEN and SLACK_CHANNEL, or neither',
    path: ['SLACK_CHANNEL'],
  })
  .refine((env) => !env.TELEGRAM_BOT_TOKEN === !env.TELEGRAM_CHAT_ID, {
    message: 'set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or neither',
    path: ['TELEGRAM_CHAT_ID'],
  })
  .refine((env) => !env.S3_ACCESS_KEY_ID === !env.S3_SECRET_ACCESS_KEY, {
    message: 'set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither',
    path: ['S3_SECRET_ACCESS_KEY'],
  })
  // S3 settings without a bucket are a typo somewhere: say so instead of using the disk
  .refine(
    (env) => env.S3_BUCKET || !(env.S3_ENDPOINT || env.S3_ACCESS_KEY_ID || process.env.S3_REGION),
    {
      message: 'S3 settings are set, but S3_BUCKET is not',
      path: ['S3_BUCKET'],
    },
  )
  // a topic without the bot is a typo somewhere: say so instead of staying silent
  .refine(
    (env) => env.TELEGRAM_BOT_TOKEN || !(env.TELEGRAM_RUNS_TOPIC || env.TELEGRAM_ERRORS_TOPIC),
    {
      message: 'a Telegram topic is set, but TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not',
      path: ['TELEGRAM_BOT_TOKEN'],
    },
  )
  .safeParse(process.env)
if (!parsed.success) {
  console.error(`Invalid server env:\n${z.prettifyError(parsed.error)}`)
  process.exit(1)
}
export const config = parsed.data
