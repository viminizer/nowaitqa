import { z } from 'zod'
import { CliError } from './output.ts'

const ServerUrl = z.url().refine((value) => {
  const u = new URL(value)
  return (
    ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash
  )
}, 'use an HTTP(S) server base URL without credentials, query or fragment')
const Seconds = z.coerce.number().int().min(1).max(86_400)
const Env = z.object({
  NOWAIT_SERVER_URL: ServerUrl.default('http://127.0.0.1:3000'),
  NOWAIT_TOKEN: z
    .string()
    .min(16)
    .regex(/^[^\p{Cc}]+$/u, 'token must not contain control characters'),
  NOWAIT_REQUEST_TIMEOUT: Seconds.default(30),
})

// All CLI environment access stays here. Help/discovery do not require credentials.
export function loadConfig(server?: string, requestTimeout?: string) {
  const parsed = Env.safeParse({
    ...process.env,
    ...(server !== undefined ? { NOWAIT_SERVER_URL: server } : {}),
    ...(requestTimeout !== undefined ? { NOWAIT_REQUEST_TIMEOUT: requestTimeout } : {}),
  })
  if (!parsed.success)
    throw new CliError(
      'configuration_error',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      2,
    )
  return {
    server: parsed.data.NOWAIT_SERVER_URL.replace(/\/+$/, ''),
    token: parsed.data.NOWAIT_TOKEN,
    requestTimeoutMs: parsed.data.NOWAIT_REQUEST_TIMEOUT * 1000,
  }
}

export const waitSeconds = (value: string | undefined) => Seconds.parse(value ?? '300')
