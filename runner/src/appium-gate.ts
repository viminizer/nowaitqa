// One loopback gateway per worker. Parent and scenario clients both pass through lease checks;
// only the parent can create sessions, and a stopped executor cannot issue another command.
import { randomUUID } from 'node:crypto'
import {
  type ClientRequest,
  createServer,
  request as httpRequest,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Device } from '@nowait/shared'
import type { LeaseGuard } from './lease-guard.ts'
import { log } from './log.ts'

const SCENARIO_HEADER = 'x-nowait-scenario'
const PARENT_HEADER = 'x-nowait-parent'
const MAX_BODY = 5 * 1024 * 1024
const CLEANUP_MS = 15_000

function reject(response: ServerResponse, message: string) {
  if (response.headersSent) return response.destroy()
  response.writeHead(409, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ value: { error: 'invalid session id', message } }))
}

export async function openAppiumGate(device: Device) {
  const target = new URL(device.appiumUrl)
  const parentToken = randomUUID()
  let trace: ((method: string, path: string) => (status: number | null) => void) | undefined
  let guard: LeaseGuard | undefined
  let token = ''
  let scenarioAllowed = false
  let commandsAllowed = false
  let sessionId: string | undefined
  let uncertainCreation = false
  let abandonedCommand = false
  let sessionUnavailable = false
  const sessions = new Set<string>()
  const requests = new Map<
    ClientRequest,
    {
      response: ServerResponse
      scenario: boolean
      creating: boolean
      finish: (status: number | null) => void
    }
  >()
  const upstreamUrl = (path: string) =>
    new URL(target.origin + target.pathname.replace(/\/$/, '') + path)
  const stopRequests = (scenarioOnly: boolean) => {
    for (const [request, active] of requests) {
      if (scenarioOnly && !active.scenario) continue
      if (active.creating) uncertainCreation = true
      abandonedCommand = true
      active.finish(null)
      reject(active.response, 'attempt stopped')
      request.destroy()
    }
  }
  const server = createServer((req, res) => {
    const handle = async () => {
      const current = guard
      if (!current || !commandsAllowed) return reject(res, 'no active attempt')
      const scenario = req.headers[SCENARIO_HEADER] !== undefined
      if (!scenario && req.headers[PARENT_HEADER] !== parentToken)
        return reject(res, 'unauthorized command')
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      const creating = req.method === 'POST' && path === '/session'
      if (scenario && (!scenarioAllowed || req.headers[SCENARIO_HEADER] !== token))
        return reject(res, 'scenario stopped')
      if (
        !['GET', 'POST', 'DELETE'].includes(req.method ?? '') ||
        (creating
          ? scenario || sessionId !== undefined
          : !sessionId || !path.startsWith(`/session/${encodeURIComponent(sessionId)}/`))
      ) {
        return reject(res, 'command is outside the owned session')
      }
      // A fresh server check also fences a worker resumed after machine/process suspension.
      await current.renew()
      current.check()
      if (guard !== current || !commandsAllowed || (scenario && !scenarioAllowed))
        return reject(res, 'attempt stopped')
      const finish = trace?.(req.method ?? '', path) ?? (() => {})
      const url = upstreamUrl(req.url ?? '/')
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          method: req.method,
          headers: {
            'content-type': 'application/json',
            ...(req.headers['content-length']
              ? { 'content-length': req.headers['content-length'] }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            if (creating) {
              size += chunk.length
              if (size <= MAX_BODY) chunks.push(chunk)
            }
          })
          response.on('end', () => {
            finish(response.statusCode ?? 502)
            requests.delete(request)
            if (creating && response.statusCode && response.statusCode < 300) {
              try {
                const data = JSON.parse(Buffer.concat(chunks).toString())
                const id = data.value?.sessionId ?? data.sessionId
                if (typeof id !== 'string') throw new Error('missing session id')
                sessions.add(id)
                sessionId = id
              } catch (err) {
                uncertainCreation = true
                log(device.name, 'session creation response could not be identified', err)
              }
            }
          })
          response.on('error', (err) => {
            log(device.name, 'Appium response failed', err)
            request.destroy(err)
          })
          res.writeHead(response.statusCode ?? 502, {
            'content-type': response.headers['content-type'] ?? 'application/json',
          })
          response.pipe(res)
        },
      )
      requests.set(request, { response: res, scenario, creating, finish })
      request.on('error', (err: NodeJS.ErrnoException) => {
        finish(null)
        const active = requests.get(request)
        if (active?.creating && err.code === 'ECONNREFUSED') sessionUnavailable = true
        if (active?.creating && err.code !== 'ECONNREFUSED') uncertainCreation = true
        requests.delete(request)
        log(device.name, 'Appium command failed', err)
        reject(res, 'Appium command failed')
      })
      req.on('aborted', () => request.destroy(new Error('command client disconnected')))
      req.pipe(request)
    }
    void handle().catch((err) => {
      log(device.name, 'Appium command rejected', err)
      reject(res, 'lease authority unavailable')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Appium gate has no port')
  const options = {
    protocol: 'http' as const,
    hostname: '127.0.0.1',
    port: address.port,
    path: '/',
    headers: { [PARENT_HEADER]: parentToken },
  }
  let detach = () => {}
  return {
    options,
    observe(current: typeof trace) {
      trace = current
    },
    get sessionId() {
      return sessionId
    },
    // Evidence uses the same parent authentication and lease fence as ordinary commands.
    async inspect(
      kind: 'screenshot' | 'hierarchy' | 'device_log' | 'appium_events',
      signal: AbortSignal,
    ) {
      if (!sessionId) throw new Error('no session was established')
      const paths = {
        screenshot: '/screenshot',
        hierarchy: '/source',
        device_log: '/se/log',
        appium_events: '/appium/events',
      }
      const response = await fetch(
        `http://127.0.0.1:${address.port}/session/${encodeURIComponent(sessionId)}${paths[kind]}`,
        {
          method: kind === 'screenshot' || kind === 'hierarchy' ? 'GET' : 'POST',
          headers: { [PARENT_HEADER]: parentToken, 'content-type': 'application/json' },
          body:
            kind === 'device_log'
              ? JSON.stringify({ type: device.platform === 'ios' ? 'syslog' : 'logcat' })
              : kind === 'appium_events'
                ? '{}'
                : undefined,
          signal,
        },
      )
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Appium returned ${response.status}`)
      }
      const chunks: Uint8Array[] = []
      let bytes = 0
      const limit = kind === 'screenshot' ? MAX_BODY : 256 * 1024
      for await (const chunk of response.body ?? []) {
        bytes += chunk.length
        if (bytes > limit) throw new Error('Appium evidence exceeds response limit')
        chunks.push(chunk)
      }
      return JSON.parse(Buffer.concat(chunks).toString()).value as unknown
    },
    get sessionUnavailable() {
      return sessionUnavailable
    },
    get needsCleanup() {
      return abandonedCommand || uncertainCreation
    },
    activate(current: LeaseGuard) {
      detach()
      guard = current
      token = randomUUID()
      sessionUnavailable = false
      scenarioAllowed = true
      commandsAllowed = true
      const stop = () => stopRequests(false)
      current.signal.addEventListener('abort', stop, { once: true })
      detach = () => current.signal.removeEventListener('abort', stop)
      return { [SCENARIO_HEADER]: token }
    },
    stopScenario() {
      scenarioAllowed = false
      stopRequests(true)
    },
    stopCommands() {
      commandsAllowed = false
      stopRequests(false)
    },
    async cleanup() {
      scenarioAllowed = false
      commandsAllowed = false
      stopRequests(false)
      let clean = !uncertainCreation
      for (const id of sessions) {
        const finish = trace?.('DELETE', '/session/owned')
        try {
          const response = await fetch(upstreamUrl(`/session/${encodeURIComponent(id)}`), {
            method: 'DELETE',
            signal: AbortSignal.timeout(CLEANUP_MS),
          })
          const data = response.status === 204 ? null : await response.json()
          finish?.(response.status)
          if (
            !(response.ok && (data === null || data.value === null)) &&
            !(response.status === 404 && data?.value?.error === 'invalid session id')
          )
            throw new Error(`session deletion returned ${response.status}`)
          sessions.delete(id)
          if (sessionId === id) sessionId = undefined
        } catch (err) {
          finish?.(null)
          clean = false
          log(device.name, 'session cleanup not confirmed', err)
        }
      }
      if (clean) abandonedCommand = false
      return clean
    },
    async close() {
      detach()
      guard = undefined
      stopRequests(false)
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export type AppiumGate = Awaited<ReturnType<typeof openAppiumGate>>
