// The one interface every chat platform implements (Slack today; Telegram or others later). A
// platform only formats and sends: what to send, when, and retries live in notify/index.ts.
import type { RunSummary, ScenarioStatus } from '@nowait/shared'

// A finished run, the same for every platform.
export type RunReport = {
  run: RunSummary
  counts: Record<ScenarioStatus, number>
  url: string | null // the run's dashboard page; null when PUBLIC_URL is not set
  flaky: string[] // scenario ids, at most REPORT_LIMIT
  failures: Failure[] // the failed scenarios, at most REPORT_LIMIT
  moreFailures: number // failed scenarios left out of `failures`
}

export type Failure = {
  scenarioId: string
  device: string | null
  error: string | null
  screenshot: string | null // file path on the server; may be gone after ARTIFACT_DAYS
}

export interface Notifier {
  name: string // stored with each sent run, so it must never change
  // Sends one finished run. Throws when it could not: the run is sent again later.
  runFinished(report: RunReport): Promise<void>
}
