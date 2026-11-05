// Disposable cleanup executor; never receives an Appium session or persisted setup values.
import { pathToFileURL } from 'node:url'
import type { Scenario } from '@nowait-qa/sdk'
import { FixtureCleanupCommand } from './scenario-protocol.ts'

const controller = new AbortController()
process.on('SIGTERM', () => controller.abort(new Error('cleanup stopped')))
process.on('disconnect', () => {
  controller.abort()
  process.exit(1)
})
let started = false
process.on('message', (input) => {
  if (started) return controller.abort(new Error('cleanup stopped'))
  const parsed = FixtureCleanupCommand.safeParse(input)
  if (!parsed.success) return process.exit(1)
  started = true
  const command = parsed.data
  const run = async () => {
    const scenario: Scenario = (await import(pathToFileURL(command.file).href)).default
    if (scenario?.id !== command.scenarioId) throw new Error('cleanup scenario identity changed')
    const fixture = scenario.fixtures?.find((f) => f.name === command.name)
    if (!fixture || typeof fixture.cleanup !== 'function')
      throw new Error('cleanup adapter unavailable')
    controller.signal.throwIfAborted()
    const clean = await fixture.cleanup({
      attemptId: command.queueId,
      key: command.key,
      account: command.account,
      signal: controller.signal,
    })
    controller.signal.throwIfAborted()
    return clean === true
  }
  const finish = (clean: boolean) => {
    if (!process.connected || !process.send) return process.exit(1)
    process.send({ clean }, (err) => process.exit(err ? 1 : 0))
  }
  void run().then(finish, () => finish(false))
})

process.send?.({ type: 'ready' }, (err) => {
  if (err) process.exit(1)
})
