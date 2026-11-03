// Sends every finished run to every chat platform that is set up. Driven by the notifications
// table, so a platform that is down, or a server restart, never loses a run: it is sent later.
import { countStatuses } from '@nowait/shared'
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { config } from '../config.ts'
import { db } from '../db/index.ts'
import { notifications, queue, results, runs } from '../db/schema.ts'
import { getRun } from '../queue.ts'
import type { Notifier, RunReport } from './notifier.ts'
import { slackNotifier } from './slack.ts'

// Add a platform here: it is on when its settings are set.
const notifiers: Notifier[] = [
  ...(config.SLACK_BOT_TOKEN && config.SLACK_CHANNEL
    ? [
        slackNotifier({
          token: config.SLACK_BOT_TOKEN,
          channel: config.SLACK_CHANNEL,
          apiUrl: config.SLACK_API_URL,
        }),
      ]
    : []),
]

const REPORT_LIMIT = 10 // failures and flaky ids per message
const BATCH = 10 // runs per platform per tick
const EVERY_MS = 15_000

export async function buildReport(runId: number): Promise<RunReport | null> {
  const run = await getRun(runId)
  if (!run) return null
  // the latest attempt of each failed scenario: a scenario is failed when its latest attempt is
  const latest = db
    .selectDistinctOn([queue.slot], {
      scenarioId: queue.scenarioId,
      device: queue.device,
      status: results.status,
      error: results.error,
      screenshot: results.screenshot,
    })
    .from(queue)
    .innerJoin(results, eq(results.queueId, queue.id))
    .where(eq(queue.runId, runId))
    .orderBy(queue.slot, desc(queue.attempt))
    .as('latest')
  const failed = await db
    .select()
    .from(latest)
    .where(eq(latest.status, 'failed'))
    .limit(REPORT_LIMIT)
  const counts = countStatuses(run.scenarios.map((s) => s.status))
  return {
    run,
    counts,
    url: config.PUBLIC_URL
      ? `${config.PUBLIC_URL.replace(/\/$/, '')}/dashboard/#/runs/${run.id}`
      : null,
    flaky: run.scenarios
      .filter((s) => s.status === 'flaky')
      .map((s) => s.id)
      .slice(0, REPORT_LIMIT),
    failures: failed.map(({ status, ...f }) => f),
    moreFailures: Math.max(counts.failed - failed.length, 0),
  }
}

async function sendDue(notifier: Notifier, log: FastifyBaseLogger) {
  // ponytail: only runs that finished in the last hour, so turning a platform on does not post the
  // whole history. A platform down for longer than that misses those runs.
  const due = await db
    .select({ id: runs.id })
    .from(runs)
    .leftJoin(
      notifications,
      and(eq(notifications.runId, runs.id), eq(notifications.notifier, notifier.name)),
    )
    .where(
      and(
        ne(runs.status, 'running'),
        gt(runs.finishedAt, sql`now() - interval '1 hour'`),
        isNull(notifications.runId),
      ),
    )
    .orderBy(runs.id)
    .limit(BATCH)
  for (const { id } of due) {
    try {
      const report = await buildReport(id)
      if (report) await notifier.runFinished(report)
      await db.insert(notifications).values({ runId: id, notifier: notifier.name })
    } catch (err) {
      log.error(
        err,
        `${notifier.name}: could not send run ${id}, trying again in ${EVERY_MS / 1000}s`,
      )
    }
  }
}

// Starts the job when a platform is set up. Each tick starts after the last one ends, so a slow
// platform never sends a run twice.
export function startNotifications(log: FastifyBaseLogger) {
  if (notifiers.length === 0) return
  log.info(`notifications on: ${notifiers.map((n) => n.name).join(', ')}`)
  const tick = async () => {
    for (const notifier of notifiers) {
      await sendDue(notifier, log).catch((err) => log.error(err, `${notifier.name} failed`))
    }
    setTimeout(tick, EVERY_MS)
  }
  setTimeout(tick, EVERY_MS)
}
