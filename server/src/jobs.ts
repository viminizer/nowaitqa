// The one way to run a timer job: once now, then `ms` after each run ends, so a restart can't skip
// a long timer (R48) and a slow run never overlaps the next. A failing job is retried on the next
// tick, and logs its first 3 failures in a row, then at most once an hour (R49): a 15 s job does
// not flood the log, and a daily job still logs every failure.
import type { FastifyBaseLogger } from 'fastify'

const QUIET_MS = 60 * 60 * 1000

export function every(
  ms: number,
  name: string,
  job: () => Promise<unknown>,
  log: FastifyBaseLogger,
) {
  let failures = 0
  let lastLog = 0
  const run = async () => {
    try {
      await job()
      failures = 0
    } catch (err) {
      failures++
      if (failures <= 3 || Date.now() - lastLog >= QUIET_MS) {
        lastLog = Date.now()
        const quiet = failures === 3 ? '; logged at most hourly from now on' : ''
        log.error(err, `${name} failed (${failures} in a row)${quiet}`)
      }
    }
    setTimeout(run, ms)
  }
  run()
}
