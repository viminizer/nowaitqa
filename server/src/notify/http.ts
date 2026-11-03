// What every chat platform does the same way: one POST with a timeout that waits out rate limits,
// and a screenshot upload that says why it could not be sent.
import { basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { messageOf } from '@nowait/shared'
import { readArtifact } from '../storage/index.ts'

const TIMEOUT_MS = 30_000 // per call; the job waits for the run, so a hung call can't block it
const RATE_LIMIT_TRIES = 5
const MAX_WAIT_S = 60

// A POST that returns the HTTP status and the JSON answer ({} when it is not JSON). On 429 it waits
// as long as the platform asks (Retry-After header, or Telegram's parameters.retry_after) and tries
// again, RATE_LIMIT_TRIES times in all.
export async function post(
  url: string,
  init: { headers?: Record<string, string>; body: BodyInit },
) {
  for (let tries = 1; ; tries++) {
    const res = await fetch(url, {
      method: 'POST',
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
      parameters?: { retry_after?: number }
    }
    if (res.status !== 429 || tries === RATE_LIMIT_TRIES) return { status: res.status, data }
    const seconds = Number(res.headers.get('retry-after')) || data.parameters?.retry_after || 1
    await sleep(Math.min(seconds, MAX_WAIT_S) * 1000)
  }
}

// Sends a failure's screenshot (its artifact key) through `upload`. sent: false with a reason when
// it can't be read or the upload failed; the caller then sends the failure as text with the reason.
export async function sendScreenshot(
  key: string | null,
  upload: (png: Buffer<ArrayBuffer>, filename: string) => Promise<unknown>,
): Promise<{ sent: boolean; reason?: string }> {
  if (!key) return { sent: false }
  let png: Buffer<ArrayBuffer>
  try {
    const data = await readArtifact(key)
    if (!data) return { sent: false, reason: 'the file is gone' }
    png = data
  } catch (err) {
    return { sent: false, reason: `the file can't be read (${messageOf(err)})` }
  }
  try {
    await upload(png, basename(key))
    return { sent: true }
  } catch (err) {
    // A timed-out upload may still arrive: the platform can't tell us, and has no way to send only
    // once. The text then says so, rather than claiming the screenshot is missing.
    if ((err as Error).name === 'TimeoutError') {
      return { sent: false, reason: 'the upload timed out; the screenshot may still appear' }
    }
    return { sent: false, reason: messageOf(err) }
  }
}
