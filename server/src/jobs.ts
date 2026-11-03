// The one way to run a timer job: once now, then `ms` after each run ends, so a restart can't skip
// a long timer (R48) and a slow run never overlaps the next. A failing job is retried on the next
// tick, and logs its first 3 failures in a row, then every 100th (R49).
import type { FastifyBaseLogger } from 'fastify'

export function every(
  ms: number,
  name: string,
  job: () => Promise<unknown>,
  log: FastifyBaseLogger,
) {
  let failures = 0
  const run = async () => {
    try {
      await job()
      failures = 0
    } catch (err) {
      failures++
      if (failures <= 3 || failures % 100 === 0) {
        log.error(err, `${name} failed (${failures} in a row)`)
      }
    }
    setTimeout(run, ms)
  }
  run()
}
