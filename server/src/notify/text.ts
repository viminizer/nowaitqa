// Text every platform builds from a report. Each adds its own markup around it.
import { formatDuration } from '@nowait/shared'
import type { RunReport } from './notifier.ts'

// &, < and > as entities: Slack mrkdwn and Telegram HTML both need it, or text from tests could
// ping <!channel> or break the markup.
export const escapeText = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

// "2 passed, 1 flaky · 3m 12s"
export function countsText({ run, counts }: RunReport) {
  const shown = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${status}`)
    .join(', ')
  return run.durationMs === null ? shown : `${shown} · ${formatDuration(run.durationMs)}`
}

// The first line of an error that says something, cut to `max` characters (a Telegram photo
// caption holds 1024).
export function errorLine(error: string | null, max = 500) {
  const line = error?.split('\n').find((l) => l.trim()) ?? 'no error message'
  return line.length > max ? `${line.slice(0, max)}…` : line
}

export const moreText = (more: number) => `…and ${more} more failed scenarios`
