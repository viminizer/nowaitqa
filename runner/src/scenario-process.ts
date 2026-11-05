// Disposable executor. The parent alone owns the lease, timers and Appium cleanup.
import { pathToFileURL } from 'node:url'
import type { Fixture, Scenario } from '@nowait-qa/sdk'
import { attach } from 'webdriverio'
import { ScenarioCommand, type ScenarioOutcome } from './scenario-protocol.ts'

const controller = new AbortController()
let started = false
let scenarioStarted = false
let requestId = 0
const registrations = new Map<
  number,
  { resolve: (key: string) => void; reject: (upgrade: boolean) => void }
>()
const stop = () => controller.abort(new Error('attempt stopped'))
process.on('SIGTERM', stop)
process.on('disconnect', () => {
  stop()
  process.exit(1)
})
process.on('message', (input) => {
  const parsed = ScenarioCommand.safeParse(input)
  if (!parsed.success) {
    console.error('invalid scenario command', parsed.error.message)
    process.exit(1)
  }
  const command = parsed.data
  if (command.type === 'stop') return stop()
  if (command.type === 'fixture_registered' || command.type === 'fixture_error') {
    const pending = registrations.get(command.requestId)
    if (pending) {
      registrations.delete(command.requestId)
      if (command.type === 'fixture_registered') pending.resolve(command.key)
      else pending.reject(command.upgradeRequired)
    }
    return
  }
  if (started) {
    console.error('scenario executor received a second start')
    process.exit(1)
  }
  started = true
  const run = async () => {
    controller.signal.throwIfAborted()
    const scenario: Scenario = (await import(pathToFileURL(command.file).href)).default
    if (scenario?.id !== command.scenarioId)
      throw new Error('scenario identity changed before execution')
    const driver = await attach({
      protocol: 'http',
      hostname: '127.0.0.1',
      port: command.port,
      path: '/',
      sessionId: command.sessionId,
      capabilities: command.capabilities,
      headers: command.headers,
      logLevel: 'warn',
      options: { waitforTimeout: 15_000 },
      connectionRetryCount: 0,
      connectionRetryTimeout: 30_000,
    })
    controller.signal.throwIfAborted()
    scenarioStarted = true
    process.send?.({ type: 'started' }, (err) => {
      if (err) console.error('could not report scenario progress', err)
    })
    const values = new Map<Fixture<unknown>, Promise<unknown>>()
    const register = (id: number, name: string, signal: AbortSignal) =>
      new Promise<string>((resolve, reject) => {
        const abort = () => {
          registrations.delete(id)
          reject(signal.reason)
        }
        const clear = () => signal.removeEventListener('abort', abort)
        registrations.set(id, {
          resolve: (key) => {
            clear()
            resolve(key)
          },
          reject: (upgrade) => {
            clear()
            reject(
              new Error(
                upgrade
                  ? 'upgrade the server before using managed fixtures'
                  : 'fixture registration unavailable; setup did not start',
              ),
            )
          },
        })
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) return abort()
        process.send?.({ type: 'fixture', requestId: id, name }, (err) => {
          if (err) {
            clear()
            registrations.delete(id)
            reject(new Error('fixture registration channel unavailable'))
          }
        })
      })
    const use = <T>(fixture: Fixture<T>): Promise<T> => {
      if (!scenario.fixtures?.includes(fixture))
        return Promise.reject(new Error('declare the fixture on the scenario before using it'))
      let value = values.get(fixture)
      if (!value) {
        value = (async () => {
          const id = ++requestId
          const timeout = AbortSignal.timeout(command.fixtureTimeoutMs)
          const signal = AbortSignal.any([controller.signal, timeout])
          let abort: () => void = () => {}
          try {
            const cancelled = new Promise<never>((_, reject) => {
              abort = () => {
                if (timeout.aborted) controller.abort(new Error('fixture setup timed out'))
                reject(signal.reason)
              }
              signal.addEventListener('abort', abort, { once: true })
              if (signal.aborted) abort()
            })
            return await Promise.race([
              (async () => {
                const key = await register(id, fixture.name, signal)
                signal.throwIfAborted()
                return fixture.setup({
                  attemptId: command.queueId,
                  key,
                  account: command.account,
                  signal,
                })
              })(),
              cancelled,
            ])
          } finally {
            signal.removeEventListener('abort', abort)
            // A cancelled race does not prove the setup callback stopped. Keep the parent's
            // hard timer armed even if the scenario catches the timeout and keeps running.
            if (!signal.aborted)
              process.send?.({ type: 'fixture_setup_done', requestId: id }, (err) => {
                if (err) console.error('could not report fixture setup completion', err.name)
              })
          }
        })()
        values.set(fixture, value)
      }
      return value as Promise<T>
    }
    await scenario.run(driver, command.account, {
      attemptId: command.queueId,
      signal: controller.signal,
      use,
    })
    controller.signal.throwIfAborted()
  }
  const finish = (outcome: ScenarioOutcome) => {
    if (!process.connected || !process.send) return process.exit(1)
    process.send(outcome, (err) => {
      if (err) console.error('could not send scenario outcome', err)
      process.exit(err ? 1 : 0)
    })
  }
  void run().then(
    () => finish({ status: 'passed', phase: 'scenario', failureKind: null, scenarioStarted }),
    (err) =>
      finish({
        status: 'failed',
        error: err instanceof Error ? (err.stack ?? err.message) : String(err),
        phase: scenarioStarted ? 'scenario' : 'setup',
        failureKind:
          err instanceof Error &&
          (err.name === 'AssertionError' || (err as NodeJS.ErrnoException).code === 'ERR_ASSERTION')
            ? 'assertion'
            : 'scenario_error',
        scenarioStarted,
      }),
  )
})
process.send?.({ type: 'ready' }, (err) => {
  if (err) {
    console.error('scenario executor could not report readiness', err)
    process.exit(1)
  }
})
