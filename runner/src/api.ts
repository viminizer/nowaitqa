// The runner's only way to reach the outside world: the server's HTTP API (R4).
import { Device, Lease, type ResultBody } from '@nowait/shared'
import { z } from 'zod'
import { config } from './config.ts'

// Throws on any status the caller does not expect, with the server's message.
async function call(method: 'GET' | 'POST', path: string, expected: number[], body?: unknown) {
  const res = await fetch(new URL(path, config.SERVER_URL), {
    method,
    headers: { authorization: `Bearer ${config.API_TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!expected.includes(res.status)) {
    throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`)
  }
  return res
}

export async function getDevices() {
  const res = await call('GET', `/devices?host=${encodeURIComponent(config.HOST)}`, [200])
  return z.array(Device).parse(await res.json())
}

export class DeviceGoneError extends Error {}

// Waits up to 30s on the server. null = no work right now.
export async function lease(device: string) {
  const res = await call('POST', '/lease', [200, 204, 404], { device })
  if (res.status === 404) throw new DeviceGoneError(`device ${device} is unknown or disabled`)
  if (res.status === 204) return null
  return Lease.parse(await res.json())
}

// false = the lease is gone (it expired and the scenario moved on).
export async function heartbeat(queueId: number, device: string) {
  const res = await call('POST', '/heartbeat', [204, 409], { queueId, device })
  return res.status === 204
}

// false = the lease is gone, so the server ignored this result.
export async function sendResult(result: ResultBody) {
  const res = await call('POST', '/results', [204, 409], result)
  return res.status === 204
}
