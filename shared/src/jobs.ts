// The one way to run a timer job: once now, then `ms` after each run ends, so a restart can't skip
// a long timer (R48) and a slow run never overlaps the next. A failing job is retried on the next
// tick, and logs its first 3 failures in a row, then at most once an hour (R49): a 15 s job does
// not flood the log, and a daily job still logs every failure. The returned stop function cancels
// the next tick and signals an in-flight job to abort.

const QUIET_MS = 60 * 60 * 1000

export function every(
  ms: number,
  name: string,
  job: (signal: AbortSignal) => Promise<unknown>,
  log: { error: (err: unknown, message: string) => void },
) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  let lastLog = 0
  const run = async () => {
    try {
      await job(controller.signal)
      failures = 0
    } catch (err) {
      if (controller.signal.aborted) return
      failures++
      if (failures <= 3 || Date.now() - lastLog >= QUIET_MS) {
        lastLog = Date.now()
        const quiet = failures === 3 && ms < QUIET_MS ? '; logged at most hourly from now on' : ''
        log.error(err, `${name} failed (${failures} in a row)${quiet}`)
      }
    }
    if (!controller.signal.aborted) timer = setTimeout(run, ms)
  }
  void run()
  return () => {
    controller.abort()
    clearTimeout(timer)
  }
}
