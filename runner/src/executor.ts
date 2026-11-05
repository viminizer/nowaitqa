// Shared termination for scenario and fixture cleanup process groups.
import type { ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { log } from './log.ts'

const STOP_GRACE_MS = 250
const STOP_LIMIT_MS = 5_000

export async function stopExecutor(child: ChildProcess, exited: Promise<void>, device: string) {
  if (!child.pid) return true
  const pid = child.pid
  const groupSignal = (signal: NodeJS.Signals | 0) => {
    try {
      process.kill(-pid, signal)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false
      throw err
    }
  }
  if (child.connected)
    child.send({ type: 'stop' }, (err) => {
      if (err) log(device, 'could not signal scenario stop', err.message)
    })
  const kill = setTimeout(() => {
    try {
      groupSignal('SIGKILL')
    } catch (err) {
      log(device, 'could not terminate scenario process group', err)
    }
  }, STOP_GRACE_MS)
  let limit: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      exited
        .then(async () => {
          // The executor can have exited with an ordinary child tool still running. Its owned
          // process group must be gone too before the device/account can be released.
          groupSignal('SIGKILL')
          const deadline = performance.now() + STOP_LIMIT_MS
          while (groupSignal(0)) {
            if (performance.now() >= deadline) return false
            await sleep(20)
          }
          return true
        })
        .catch((err) => {
          log(device, 'scenario process group cleanup failed', err)
          return false
        }),
      new Promise<false>((resolve) => {
        limit = setTimeout(() => resolve(false), STOP_LIMIT_MS)
      }),
    ])
  } finally {
    clearTimeout(kill)
    clearTimeout(limit)
  }
}
