// Disposable executor. The parent alone owns the lease, timers and Appium cleanup.
import { pathToFileURL } from 'node:url'
import type { Scenario } from '@nowait-qa/sdk'
import { attach } from 'webdriverio'
import { ScenarioCommand, type ScenarioOutcome } from './scenario-protocol.ts'

const controller = new AbortController()
let started = false
let scenarioStarted = false
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
    await scenario.run(driver, command.account, { signal: controller.signal })
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
