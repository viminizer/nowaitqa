// The runner's only way to reach the outside world: the server's HTTP API (R4).
import {
  type Catalog,
  type CreateRunBody,
  Device,
  Lease,
  messageOf,
  type ResultBody,
  RunSummary,
} from '@nowait/shared'
import { z } from 'zod'
import { config } from './config.ts'

// An answer with a status the caller did not expect.
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

// Throws on any status the caller does not expect, with the server's message.
async function call(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  expected: number[],
  body?: unknown,
  timeoutMs?: number,
) {
  const res = await fetch(new URL(path, config.SERVER_URL), {
    method,
    headers: { authorization: `Bearer ${config.RUNNER_TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  })
  if (!expected.includes(res.status)) {
    throw new HttpError(`${method} ${path} -> ${res.status} ${await res.text()}`, res.status)
  }
  return res
}

export async function sendCatalog(catalog: Catalog) {
  await call('PUT', '/catalog', [204], catalog)
}

export async function getDevices() {
  const res = await call('GET', `/devices?host=${encodeURIComponent(config.HOST)}`, [200])
  return z.array(Device).parse(await res.json())
}

export async function createRun(body: z.input<typeof CreateRunBody>) {
  const res = await call('POST', '/runs', [201], body)
  return z.object({ id: z.number().int() }).parse(await res.json()).id
}

export async function getRun(id: number) {
  const res = await call('GET', `/runs/${id}`, [200])
  return RunSummary.parse(await res.json())
}

export class DeviceGoneError extends Error {}

// Waits up to 30s on the server. null = no work right now.
export async function lease(device: string, commits: string[], runId?: number) {
  const res = await call('POST', '/lease', [200, 204, 404], { device, commits, runId })
  if (res.status === 404) throw new DeviceGoneError(`device ${device} is unknown or disabled`)
  if (res.status === 204) return null
  return Lease.parse(await res.json())
}

// false = the lease is gone (it expired and the scenario moved on).
export async function heartbeat(queueId: number, device: string) {
  const res = await call('POST', '/heartbeat', [204, 409], { queueId, device })
  return res.status === 204
}

// A result that could not be sent after every try.
export class ResultNotSentError extends Error {}

const RESULT_TRIES = 4
// Longer than the server takes at most: its uploads stop at 100 s, the lease is renewed for 130 s
// (server/src/queue.ts). R34.
const RESULT_TIMEOUT_MS = 150_000

// false = the lease is gone, so the server ignored this result (or an earlier try of this call
// already saved it). A network error, a timeout or a 5xx is tried again: the server can take the
// same result twice (the files get the same keys, and only one try records the attempt).
export async function sendResult(result: ResultBody) {
  for (let tries = 1; ; tries++) {
    try {
      const res = await call('POST', '/results', [204, 409], result, RESULT_TIMEOUT_MS)
      return res.status === 204
    } catch (err) {
      const retry = !(err instanceof HttpError) || err.status >= 500
      if (!retry || tries === RESULT_TRIES) {
        throw new ResultNotSentError(`result not sent (${tries} tries): ${messageOf(err)}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 2 ** tries * 1000)) // 2, 4, 8 s
    }
  }
}
