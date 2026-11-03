// Slack, through the Web API with a bot token: a webhook can't post in threads or upload files.
// The app needs the chat:write and files:write scopes, and must be in the channel.
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { formatDuration } from '@nowait/shared'
import { type Failure, type Notifier, PartialSendError, type RunReport } from './notifier.ts'

// apiUrl: https://slack.com/api, or https://slack-gov.com/api for GovSlack.
type Settings = { token: string; channel: string; apiUrl: string }

const TIMEOUT_MS = 30_000 // per call; the job waits for the run, so a hung call can't block it
const RATE_LIMIT_TRIES = 3

export function slackNotifier({ token, channel, apiUrl }: Settings): Notifier {
  // Slack answers 200 with { ok: false, error } when a call fails, and 429 with Retry-After when
  // it is rate limited: then it waits and tries again.
  async function call(method: string, body: Record<string, unknown>, form = false) {
    for (let tries = 1; ; tries++) {
      const res = await fetch(`${apiUrl}/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
        },
        body: form
          ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]))
          : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.status === 429 && tries < RATE_LIMIT_TRIES) {
        await sleep(Math.min(Number(res.headers.get('retry-after')) || 1, 30) * 1000)
        continue
      }
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
      if (!data.ok) throw new Error(`slack ${method}: ${data.error ?? `HTTP ${res.status}`}`)
      return data as Record<string, unknown>
    }
  }

  async function upload(
    channelId: string,
    threadTs: string,
    text: string,
    path: string,
    png: Buffer<ArrayBuffer>,
  ) {
    const filename = basename(path)
    const { upload_url, file_id } = await call(
      'files.getUploadURLExternal',
      { filename, length: png.length },
      true,
    )
    const res = await fetch(String(upload_url), {
      method: 'POST',
      body: png,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`slack upload: HTTP ${res.status}`)
    await call('files.completeUploadExternal', {
      files: [{ id: file_id, title: filename }],
      channel_id: channelId,
      thread_ts: threadTs,
      initial_comment: text,
    })
  }

  // A thread reply with the screenshot. When the file is gone or the upload fails, the reply is
  // text with the reason.
  async function reply(channelId: string, threadTs: string, failure: Failure) {
    let text = failureText(failure)
    if (failure.screenshot) {
      const path = failure.screenshot
      try {
        const png = await readFile(path).catch((err) => {
          throw new Error(`the file is gone (${err.code ?? err.message})`)
        })
        return await upload(channelId, threadTs, text, path, png)
      } catch (err) {
        text += `\n_(screenshot not attached: ${mrkdwn((err as Error).message)})_`
      }
    }
    await call('chat.postMessage', { channel: channelId, thread_ts: threadTs, text })
  }

  return {
    name: 'slack',
    async runFinished(report) {
      const summary = await call('chat.postMessage', { channel, text: summaryText(report) })
      // From here the run is in the channel: a failed reply must not post it again.
      try {
        // the answer has the channel's id, which file uploads need (SLACK_CHANNEL may be a name)
        const channelId = String(summary.channel)
        const threadTs = String(summary.ts)
        for (const failure of report.failures) await reply(channelId, threadTs, failure)
        if (report.moreFailures > 0) {
          const link = report.url ? ` (<${report.url}|see all>)` : ''
          const text = `…and ${report.moreFailures} more failed scenarios${link}`
          await call('chat.postMessage', { channel: channelId, thread_ts: threadTs, text })
        }
      } catch (err) {
        throw new PartialSendError(`the thread is incomplete: ${(err as Error).message}`)
      }
    },
  }
}

// Text from tests goes into Slack mrkdwn: &, < and > must be escaped, or `<!channel>` in an error
// would ping everyone (https://api.slack.com/reference/surfaces/formatting#escaping).
const mrkdwn = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

function summaryText({ run, counts, url, flaky }: RunReport) {
  const icon = run.status === 'passed' ? ':white_check_mark:' : ':x:'
  const title = url ? `<${url}|Run #${run.id}>` : `Run #${run.id}`
  const shown = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${status}`)
    .join(', ')
  const took = run.durationMs === null ? '' : ` · ${formatDuration(run.durationMs)}`
  return [
    `${icon} *${title} ${run.status}* · ${run.platform} · ${shown}${took}`,
    `commit \`${run.commit.slice(0, 7)}\` · ${mrkdwn(run.trigger)}`,
    ...(flaky.length > 0 ? [`flaky: ${mrkdwn(flaky.join(', '))}`] : []),
  ].join('\n')
}

function failureText({ scenarioId, device, error }: Failure) {
  // the first line that says something; backticks would end the code block early
  const line = error?.split('\n').find((l) => l.trim()) ?? 'no error message'
  const where = device ? ` on ${mrkdwn(device)}` : ''
  return `:x: *${mrkdwn(scenarioId)}*${where}\n\`\`\`${mrkdwn(line.replaceAll('`', "'"))}\`\`\``
}
