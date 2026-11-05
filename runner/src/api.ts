// The runner's only way to reach the outside world: the server's HTTP API (R4).

import { setTimeout as sleep } from 'node:timers/promises'
import {
  type Catalog,
  type CreateRunBody,
  DEVICE_CONTACT_TIMEOUT_MS,
  Device,
  DevicePause,
  Lease,
  messageOf,
  type ResultBody,
  RevisionPage,
  RunSummary,
} from '@nowait/shared'
import { z } from 'zod'
import { config } from './config.ts'
import { log } from './log.ts'

// An answer with a status the caller did not expect.
class HttpError extends Error {
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
  signal?: AbortSignal,
) {
  const timeout = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
  const res = await fetch(new URL(path, config.SERVER_URL), {
    method,
    headers: { authorization: `Bearer ${config.RUNNER_TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal && timeout ? AbortSignal.any([signal, timeout]) : (signal ?? timeout),
  })
  if (!expected.includes(res.status)) {
    throw new HttpError(`${method} ${path} -> ${res.status} ${await res.text()}`, res.status)
  }
  return res
}

export async function sendCatalog(catalog: Catalog, signal?: AbortSignal) {
  await call('PUT', '/catalog', [204], catalog, 10_000, signal)
}

export async function referencedCommits(signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(30_000)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
  const commits = new Set<string>()
  const cleanup = new Set<string>()
  let after = 0
  while (true) {
    let res: Response
    try {
      res = await call(
        'GET',
        `/catalog/revisions${after ? `?after=${after}` : ''}`,
        [200],
        undefined,
        10_000,
        combined,
      )
    } catch (err) {
      if (err instanceof HttpError && err.status === 404)
        throw new Error('upgrade the server: scenario revision references are required')
      throw err
    }
    const page = RevisionPage.parse(await res.json())
    for (const revision of page.revisions) {
      commits.add(revision.commit)
      if (revision.cleanupPending) cleanup.add(revision.commit)
    }
    if (page.next === null) return { commits, cleanup }
    if (page.next <= after) throw new Error('revision reference cursor did not advance')
    after = page.next
  }
}

export async function getDevices(signal?: AbortSignal) {
  const res = await call(
    'GET',
    `/devices?host=${encodeURIComponent(config.HOST)}`,
    [200],
    undefined,
    10_000,
    signal,
  )
  return z.array(Device).parse(await res.json())
}

// A separate request: keep reporting contact during long polls, Appium startup and cooldowns.
export async function contactDevice(device: Device, signal: AbortSignal) {
  await call(
    'POST',
    '/devices/contact',
    [204],
    { name: device.name, host: config.HOST, udid: device.udid, platform: device.platform },
    DEVICE_CONTACT_TIMEOUT_MS,
    signal,
  )
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
export class DevicePausedError extends Error {
  readonly until: number
  constructor(readonly seconds: number) {
    super(`device is paused for ${seconds}s`)
    this.until = Date.now() + seconds * 1000
  }
}

// Waits up to 30s on the server. null = no work right now.
export async function lease(
  device: string,
  commits: string[],
  runId?: number,
  signal?: AbortSignal,
) {
  const res = await call(
    'POST',
    '/lease',
    [200, 204, 404, 423],
    { device, commits, runId, cleanup: true },
    35_000,
    signal,
  )
  if (res.status === 423) {
    throw new DevicePausedError(DevicePause.parse(await res.json()).retryAfterSeconds)
  }
  if (res.status === 404) throw new DeviceGoneError(`device ${device} is unknown or disabled`)
  if (res.status === 204) return null
  return Lease.parse(await res.json())
}

// false = the lease is gone (it expired and the scenario moved on).
export async function heartbeat(
  queueId: number,
  device: string,
  signal?: AbortSignal,
  timeoutMs = 5_000,
  scenarioStarted?: true,
) {
  const res = await call(
    'POST',
    '/heartbeat',
    [204, 409],
    { queueId, device, scenarioStarted },
    timeoutMs,
    signal,
  )
  return res.status === 204
}

export async function releaseLease(queueId: number, device: string) {
  const res = await call('POST', '/release', [204, 409], { queueId, device }, 10_000)
  return res.status === 204
}

// A result that could not be sent after every try, because the server could not be reached or
// kept failing. One of the tries may still be saved by the server.
export class ResultNotSentError extends Error {}

const RESULT_TRIES = 4
// Longer than the server takes at most: its uploads stop at 100 s, the lease is renewed for 130 s
// (server/src/queue.ts). R34.
const RESULT_TIMEOUT_MS = 150_000

// A failure that a new try can fix: no answer (a network error) or a busy or failing server.
// Not a timeout: by then the lease has run out, so a new try can only get 409. Not another 4xx:
// the same body gets the same answer.
const worthRetrying = (err: unknown) =>
  err instanceof HttpError
    ? err.status >= 500 || err.status === 408 || err.status === 429
    : (err as Error).name !== 'TimeoutError'

// false = the lease is gone, so the server ignored this result (or an earlier try of this call
// already saved it). A failure worth retrying is tried again: the server can take the same result
// twice (the files get the same keys, and only one try records the attempt).
export async function sendResult(result: ResultBody) {
  for (let tries = 1; ; tries++) {
    try {
      const res = await call('POST', '/results', [204, 409], result, RESULT_TIMEOUT_MS)
      return res.status === 204
    } catch (err) {
      if (!worthRetrying(err)) throw err // the worker reports it, with the server's reason
      if (tries === RESULT_TRIES) {
        throw new ResultNotSentError(`result not sent (${tries} tries): ${messageOf(err)}`)
      }
      log(result.device, `result try ${tries} failed, trying again: ${messageOf(err)}`)
      await sleep(2 ** tries * 1000) // 2, 4, 8 s
    }
  }
}
