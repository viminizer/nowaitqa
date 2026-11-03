// Loads the scenarios, starts one worker per enabled phone on this machine, and picks up new
// phones every minute.
import { getDevices } from './api.ts'
import { startScenarios } from './catalog.ts'
import { config } from './config.ts'
import { log } from './log.ts'
import { runWorker } from './worker.ts'

const running = new Set<string>()

async function startNewWorkers() {
  for (const device of await getDevices()) {
    if (!device.enabled || running.has(device.name)) continue
    running.add(device.name)
    runWorker(device)
      .catch((err) => log(device.name, 'worker crashed', err))
      .finally(() => running.delete(device.name))
  }
}

log(config.HOST, `runner starting, server ${config.SERVER_URL}`)
await startScenarios()
await startNewWorkers()
setInterval(
  () => startNewWorkers().catch((err) => log(config.HOST, 'could not refresh devices', err)),
  60_000,
)
