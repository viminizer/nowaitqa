// Bounded metadata only: command bodies, headers and raw capabilities are never recorded.
import {
  AttemptDiagnostics,
  type AttemptProgress,
  type AttemptStage,
  type CommandTiming,
  type Device,
  every,
  type InputRuntime,
  type Lease,
  messageOf,
} from '@nowait/shared'
import { z } from 'zod'
import { sendProgress } from './api.ts'
import type { AppiumGate } from './appium-gate.ts'
import { config } from './config.ts'
import { log } from './log.ts'

function commandName(method: string, path: string): CommandTiming['command'] {
  if (path === '/session' && method === 'POST') return 'session_create'
  if (/^\/session\/[^/]+$/.test(path) && method === 'DELETE') return 'session_delete'
  if (path.endsWith('/screenshot')) return 'screenshot'
  if (path.endsWith('/source')) return 'source'
  if (path.endsWith('/se/log')) return 'device_logs'
  if (path.endsWith('/appium/events')) return 'appium_events'
  if (/\/elements?$/.test(path)) return 'find_element'
  if (path.endsWith('/click')) return 'click'
  if (path.endsWith('/value')) return 'set_value'
  if (/\/execute\/(sync|async)$/.test(path)) return 'execute'
  return 'other'
}

export function attemptTrace(device: Device, lease: Lease) {
  const secrets = [config.RUNNER_TOKEN, config.TEST_ACCOUNT_PASSWORD, lease.account, lease.appBuild]
    .filter((s): s is string => !!s)
    .flatMap((s) => [s, encodeURIComponent(s)])
    .sort((a, b) => b.length - a.length)
  const redact = (value: string, limit: number) => {
    let text = value
    for (const secret of secrets) text = text.replaceAll(secret, '[redacted]')
    const sanitized = text
      .replace(
        /(\bauthorization["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi,
        '$1[redacted]',
      )
      .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]')
      .replace(
        /((?:password|passwd|token|authorization|secret|api[_-]?key)\s*["']?\s*[:=]\s*)[^\s,;}]+/gi,
        '$1[redacted]',
      )
    const bytes = Buffer.from(sanitized)
    let start = Math.max(0, bytes.length - limit)
    // Start at a complete UTF-8 character, so decoding cannot grow past the byte cap.
    while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++
    return bytes.subarray(start).toString('utf8')
  }
  let revision = 1
  let sequence = 1
  let stage: AttemptStage = 'app_staging'
  let updatedAt = new Date().toISOString()
  const events: AttemptProgress['events'] = [{ id: sequence, stage, at: updatedAt }]
  const commands: CommandTiming[] = []
  let droppedEvents = 0
  let droppedCommands = 0
  let runtime: InputRuntime | null = null
  const missing: AttemptDiagnostics['missing'] = [
    {
      item: 'appium_host_log',
      reason:
        'Remote Appium host logs are not exposed by the session API; command metadata is included.',
    },
  ]
  let deviceLog: string | null = null
  let hierarchy: string | null = null
  let appiumEvents: AttemptDiagnostics['appiumEvents'] = []
  let sessionId: string | null = null
  const snapshot = (): AttemptProgress => ({
    revision,
    stage,
    updatedAt,
    events: events.map((e) => ({ ...e })),
    commands: commands.map((c) => ({ ...c })),
    droppedEvents,
    droppedCommands,
  })
  const changed = () => {
    revision++
    updatedAt = new Date().toISOString()
  }
  const enter = (next: AttemptStage) => {
    if (stage === next) return
    stage = next
    changed()
    events.push({ id: ++sequence, stage, at: updatedAt })
    if (events.length > 80) {
      events.shift()
      droppedEvents++
    }
  }
  const stopPublishing = every(
    5_000,
    'attempt progress',
    (signal) => {
      changed() // A slow command still reports fresh contact without advancing its phase.
      return sendProgress(
        {
          queueId: lease.queueId,
          device: device.name,
          progress: snapshot(),
        },
        signal,
      )
    },
    { error: (err, message) => log(device.name, message, err) },
  )
  return {
    enter,
    runtime(value: InputRuntime) {
      runtime = value
    },
    command(method: string, path: string) {
      const started = performance.now()
      const timing: CommandTiming = {
        id: ++sequence,
        command: commandName(method, path),
        startedAt: new Date().toISOString(),
        durationMs: 0,
        status: 'running',
      }
      commands.push(timing)
      if (commands.length > 80) {
        commands.shift()
        droppedCommands++
      }
      changed()
      let complete = false
      return (status: number | null) => {
        if (complete) return
        complete = true
        timing.durationMs = Math.min(2_147_483_647, Math.round(performance.now() - started))
        timing.status = status === null ? 'interrupted' : status < 400 ? 'passed' : 'failed'
        if (status !== null) timing.httpStatus = status
        changed()
      }
    },
    // Collect before session disposal, including failures after remote() created a session.
    async capture(gate: AppiumGate | null, permitted: boolean, failed: boolean) {
      sessionId = gate?.sessionId ? redact(gate.sessionId, 200) : null
      enter('evidence')
      const items = ['screenshot', 'device_log', 'hierarchy', 'appium_events'] as const
      if (!permitted || !gate?.sessionId || !failed) {
        for (const item of items)
          missing.push({
            item,
            reason: !gate
              ? 'No session was assigned to this attempt.'
              : !permitted
                ? 'Lease authority or executor termination is unconfirmed.'
                : !gate.sessionId
                  ? 'No session was established.'
                  : 'Not collected for a passed attempt.',
          })
        return {}
      }
      const signal = AbortSignal.timeout(15_000)
      let screenshot: string | undefined
      await Promise.all(
        items.map(async (item) => {
          try {
            const value = await gate.inspect(item, signal)
            signal.throwIfAborted()
            if (item === 'screenshot') screenshot = z.base64().parse(value)
            if (item === 'device_log') {
              const lines = z
                .array(z.object({ timestamp: z.number().finite(), message: z.string() }))
                .parse(value)
              deviceLog = redact(
                lines
                  .slice(-500)
                  .map((l) => `${l.timestamp} ${l.message}`)
                  .join('\n'),
                65536,
              )
            }
            if (item === 'hierarchy') {
              // Retain tree structure only, stripping all text, attributes and arbitrary tag names.
              hierarchy = (
                z
                  .string()
                  .parse(value)
                  .match(/<\/?[a-zA-Z][^>]*>/g) ?? []
              )
                .map((tag) =>
                  tag.startsWith('</') ? '</node>' : tag.endsWith('/>') ? '<node/>' : '<node>',
                )
                .join('\n')
                .slice(0, 65536)
            }
            if (item === 'appium_events') {
              const data = z
                .object({
                  commands: z.array(
                    z.object({
                      cmd: z.string(),
                      startTime: z.number().finite(),
                      endTime: z.number().finite(),
                    }),
                  ),
                })
                .parse(value)
              const start = Date.parse(events[0]?.at ?? updatedAt)
              appiumEvents = data.commands
                .filter((c) => c.startTime >= start && c.endTime >= c.startTime)
                .slice(-80)
                .map((c) => ({
                  command:
                    (
                      {
                        createSession: 'session_create',
                        deleteSession: 'session_delete',
                        findElement: 'find_element',
                        click: 'click',
                        setValue: 'set_value',
                        getScreenshot: 'screenshot',
                        getPageSource: 'source',
                        execute: 'execute',
                      } as Record<string, CommandTiming['command']>
                    )[c.cmd] ?? 'other',
                  startedAt: c.startTime,
                  durationMs: c.endTime - c.startTime,
                }))
            }
          } catch (err) {
            missing.push({
              item,
              reason: signal.aborted
                ? 'Evidence collection exceeded 15 seconds.'
                : redact(messageOf(err), 200),
            })
          }
        }),
      )
      if (signal.aborted) gate.stopCommands()
      return { screenshot, log: deviceLog ?? undefined }
    },
    finish(error?: string) {
      stopPublishing()
      enter('finished')
      const parsed = AttemptDiagnostics.safeParse({
        version: 1,
        progress: snapshot(),
        sessionId,
        error: error ? redact(error, 8192) : null,
        runtime,
        config: {
          sessionMode: config.SESSION_MODE,
          scenarioTimeoutSeconds: config.SCENARIO_TIMEOUT_SECONDS,
        },
        deviceLog,
        hierarchy,
        appiumEvents,
        missing,
      })
      if (parsed.success) return parsed.data
      log(device.name, 'diagnostic snapshot was invalid; preserving the test result')
      return undefined
    },
    stop: stopPublishing,
  }
}
export type AttemptTrace = ReturnType<typeof attemptTrace>
