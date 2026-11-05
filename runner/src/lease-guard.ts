// Authority belongs to the last successful renewal, never to a timer that merely tried one.
import { type Device, every, type Lease } from '@nowait/shared'
import { heartbeat } from './api.ts'
import { log } from './log.ts'

export function watchLease(device: Device, lease: Lease, shutdown: AbortSignal) {
  const controller = new AbortController()
  const signal = AbortSignal.any([shutdown, controller.signal])
  const lifetime = lease.leaseSeconds * 1000
  let deadline = performance.now() + lifetime
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let pending: Promise<void> | undefined

  const check = () => {
    if (stopped) throw new Error('attempt finished')
    if (performance.now() >= deadline) controller.abort(new Error('lease renewal deadline elapsed'))
    signal.throwIfAborted()
  }
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(
      () => controller.abort(new Error('lease renewal deadline elapsed')),
      Math.max(0, deadline - performance.now()),
    )
  }
  const renew = () => {
    check()
    pending ??= (async () => {
      const started = performance.now()
      const alive = await heartbeat(
        lease.queueId,
        device.name,
        signal,
        Math.min(5_000, lifetime / 4),
      )
      check()
      if (!alive) {
        controller.abort(new Error('lease is gone'))
        signal.throwIfAborted()
      }
      // Count request/response latency against authority; a delayed response cannot extend it.
      deadline = started + lifetime
      check()
      arm()
    })().finally(() => {
      pending = undefined
    })
    return pending
  }
  arm()
  const stopPolling = every(lifetime / 4, 'lease heartbeat', async () => renew(), {
    error: (err, message) => log(device.name, message, err),
  })
  const halt = () => {
    stopPolling()
    clearTimeout(timer)
  }
  signal.addEventListener('abort', halt, { once: true })
  if (signal.aborted) halt()
  const stop = () => {
    stopped = true
    stopPolling()
    clearTimeout(timer)
    controller.abort(new Error('attempt finished'))
  }
  return { signal, check, renew, stop }
}

export type LeaseGuard = ReturnType<typeof watchLease>
