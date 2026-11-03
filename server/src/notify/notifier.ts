// The one interface every chat platform implements (Slack, Telegram; Kevin asked for it so more
// can be added the same way). A platform only formats and sends: what to send and when live in
// notify/index.ts, and the HTTP retry and screenshot fallback in notify/http.ts.
import type { RunSummary, ScenarioStatus } from '@nowait/shared'

// A finished run, the same for every platform.
export type RunReport = {
  run: RunSummary
  counts: Record<ScenarioStatus, number>
  url: string | null // the run's dashboard page; null when PUBLIC_URL is not set
  flaky: string[] // scenario ids, at most REPORT_LIMIT
  failures: Failure[] // the failed scenarios in slot order, at most REPORT_LIMIT
  moreFailures: number // failed scenarios left out of `failures`
}

export type Failure = {
  scenarioId: string
  device: string | null
  error: string | null
  screenshot: string | null // artifact key (storage/); may be gone after ARTIFACT_DAYS
}

// The main message went out, but some details did not. The run counts as sent (sending it again
// would post it twice) and the error is logged.
export class PartialSendError extends Error {}

export interface Notifier {
  name: string // stored with each sent run, so it must never change
  // Sends one finished run. Throws when the main message could not be sent: the run is sent again
  // later. Throws PartialSendError when only details failed.
  runFinished(report: RunReport): Promise<void>
}
