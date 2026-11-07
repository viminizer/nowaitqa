// Loads the scenarios, starts one worker per enabled phone on this machine, and picks up new
// phones every minute.

import { every } from '@nowait/shared'
import { getDevices } from './api.ts'
import { startScenarios } from './catalog.ts'
import { config } from './config.ts'
import { log } from './log.ts'
import { startVirtualSetup } from './virtual-setup.ts'
import { runWorker } from './worker.ts'

const running = new Set<string>()
const shutdown = new AbortController()
process.once('SIGINT', () => shutdown.abort(new Error('runner stopping')))
process.once('SIGTERM', () => shutdown.abort(new Error('runner stopping')))

async function startNewWorkers(signal: AbortSignal) {
  for (const device of await getDevices(signal)) {
    if (shutdown.signal.aborted || !device.enabled || running.has(device.name)) continue
    running.add(device.name)
    runWorker(device, shutdown.signal)
      .catch((err) => log(device.name, 'worker crashed', err))
      .finally(() => running.delete(device.name))
  }
}

log(config.HOST, `runner starting, server ${config.SERVER_URL}`)
startVirtualSetup(shutdown.signal)
await startScenarios(shutdown.signal)
const stopDiscovery = every(60_000, 'device discovery', startNewWorkers, {
  error: (err, message) => log(config.HOST, message, err),
})
shutdown.signal.addEventListener('abort', stopDiscovery, { once: true })
if (shutdown.signal.aborted) stopDiscovery()
