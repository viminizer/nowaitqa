import { setTimeout as sleep } from 'node:timers/promises'
import { waitSeconds } from './config.ts'
import { CliError } from './output.ts'

// The wall-clock deadline includes each HTTP read and sleep; stopping observation never cancels work.
export async function waitFor<T>(
  read: (signal: AbortSignal) => Promise<T>,
  running: (data: T) => boolean,
  passed: (data: T) => boolean,
  timeout: string | undefined,
  shutdown: AbortSignal,
) {
  const signal = AbortSignal.any([shutdown, AbortSignal.timeout(waitSeconds(timeout) * 1000)])
  let last: T | undefined
  try {
    while (true) {
      last = await read(signal)
      if (!running(last)) {
        if (!passed(last))
          throw new CliError('work_failed', 'Work finished without passing', 5, { data: last })
        return last
      }
      await sleep(1000, undefined, { signal })
    }
  } catch (err) {
    if (shutdown.aborted)
      throw new CliError('interrupted', 'Stopped observing; server work continues', 130)
    if (signal.aborted)
      throw new CliError('wait_timeout', 'Wait deadline reached; server work continues', 4, {
        data: last,
      })
    throw err
  }
}
