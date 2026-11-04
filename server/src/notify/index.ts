// Sends every finished run to every chat platform that is set up. Driven by the notifications
// table, so a platform that is down, or a server restart, does not lose a run: it is sent later,
// for up to RETRY_HOURS. Runs that finished before a platform was first turned on are not sent.
import { countStatuses, every } from '@nowait/shared'
import { and, desc, eq, gte, isNull, ne, sql } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import { config } from '../config.ts'
import { db } from '../db/index.ts'
import { notifications, notifiersOn, queue, results, runs } from '../db/schema.ts'
import { getRun } from '../queue.ts'
import { type Notifier, PartialSendError, type RunReport } from './notifier.ts'
import { slackNotifier } from './slack.ts'
import { telegramNotifier } from './telegram.ts'

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
  ...(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID
    ? [
        telegramNotifier({
          token: config.TELEGRAM_BOT_TOKEN,
          chatId: config.TELEGRAM_CHAT_ID,
          runsTopic: config.TELEGRAM_RUNS_TOPIC,
          errorsTopic: config.TELEGRAM_ERRORS_TOPIC,
          apiUrl: config.TELEGRAM_API_URL,
        }),
      ]
    : []),
]

const REPORT_LIMIT = 10 // failures and flaky ids per message
const BATCH = 10 // runs per platform per tick
const EVERY_MS = 15_000
const RETRY_HOURS = 24
const LOG_EVERY = 240 // a run that keeps failing: logged on its first 3 failures, then hourly

// How many times each run failed to send, per platform. In memory: a restart only logs again.
const failures = new Map<string, { count: number; first: number }>()

async function buildReport(runId: number): Promise<RunReport | null> {
  const run = await getRun(runId)
  if (!run) return null
  // the latest attempt of each scenario; a scenario of a finished run failed when that one did
  const latest = db
    .selectDistinctOn([queue.slot], {
      slot: queue.slot,
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
    .orderBy(latest.slot)
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
    failures: failed.map(({ slot, status, ...f }) => f),
    moreFailures: Math.max(counts.failed - failed.length, 0),
  }
}

// When the platform was first turned on: runs that finished before are history, not news.
async function turnedOnAt(name: string) {
  await db.insert(notifiersOn).values({ name }).onConflictDoNothing()
  const row = await db.query.notifiersOn.findFirst({ where: eq(notifiersOn.name, name) })
  if (!row) throw new Error(`notifier ${name} has no start time`)
  return row.since
}

async function sendDue(notifier: Notifier, since: Date, log: FastifyBaseLogger) {
  // a run past the retry window is not tried again: forget its failure count
  for (const [key, entry] of failures) {
    if (Date.now() - entry.first > RETRY_HOURS * 60 * 60 * 1000) failures.delete(key)
  }
  // Newest first, so one run that keeps failing can't hold back the others.
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
        gte(runs.finishedAt, since),
        gte(runs.finishedAt, sql`now() - make_interval(hours => ${RETRY_HOURS})`),
        isNull(notifications.runId),
      ),
    )
    .orderBy(desc(runs.finishedAt))
    .limit(BATCH)
  const markSent = (id: number) =>
    db.insert(notifications).values({ runId: id, notifier: notifier.name })

  for (const { id } of due) {
    const key = `${notifier.name}:${id}`
    try {
      const report = await buildReport(id)
      if (report) await notifier.runFinished(report)
      await markSent(id)
      failures.delete(key)
    } catch (err) {
      if (err instanceof PartialSendError) {
        log.error(err, `${notifier.name}: run ${id} sent, but not all of it`)
        // a database error here must not skip the rest of the batch (R51)
        await markSent(id).catch((dbErr) =>
          log.error(dbErr, `${notifier.name}: run ${id} sent, but not marked as sent`),
        )
        failures.delete(key)
        continue
      }
      const entry = failures.get(key) ?? { count: 0, first: Date.now() }
      entry.count++
      failures.set(key, entry)
      const count = entry.count
      if (count <= 3 || count % LOG_EVERY === 0) {
        const again = `trying again every ${EVERY_MS / 1000}s for up to ${RETRY_HOURS}h`
        const quiet = count === 3 ? '; logged hourly from now on' : ''
        log.error(
          err,
          `${notifier.name}: could not send run ${id} (${count} tries), ${again}${quiet}`,
        )
      }
    }
  }
}

// Starts one job per platform that is set up (shared/src/jobs.ts), so a slow or rate-limited platform never
// holds back another, and a run is never sent twice (ticks don't overlap). It first records when
// each one was turned on: now, not at the first tick, so a run that ends in between is news.
export async function startNotifications(log: FastifyBaseLogger) {
  if (notifiers.length === 0) return
  log.info(`notifications on: ${notifiers.map((n) => n.name).join(', ')}`)
  for (const notifier of notifiers) {
    const since = await turnedOnAt(notifier.name) // read once: it never changes after this
    every(EVERY_MS, `notifications to ${notifier.name}`, () => sendDue(notifier, since, log), log)
  }
}
