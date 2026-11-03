// Slack, through the Web API with a bot token: a webhook can't post in threads or upload files.
// The app needs the chat:write and files:write scopes, and must be in the channel.
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { formatDuration } from '@nowait/shared'
import type { Failure, Notifier, RunReport } from './notifier.ts'

type Settings = { token: string; channel: string; apiUrl: string }

export function slackNotifier({ token, channel, apiUrl }: Settings): Notifier {
  // Slack answers 200 with { ok: false, error } when a call fails.
  async function call(method: string, body: Record<string, unknown>, form = false) {
    const res = await fetch(`${apiUrl}/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      },
      body: form
        ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]))
        : JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    if (!data.ok) throw new Error(`slack ${method}: ${data.error ?? `HTTP ${res.status}`}`)
    return data as Record<string, unknown>
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
    const res = await fetch(String(upload_url), { method: 'POST', body: png })
    if (!res.ok) throw new Error(`slack upload: HTTP ${res.status}`)
    await call('files.completeUploadExternal', {
      files: [{ id: file_id, title: filename }],
      channel_id: channelId,
      thread_ts: threadTs,
      initial_comment: text,
    })
  }

  // A thread reply with the screenshot when it is still on disk. If the upload fails, the reply is
  // sent as text with the reason, so the summary is never posted twice for one missing file.
  async function reply(channelId: string, threadTs: string, failure: Failure) {
    let text = failureText(failure)
    const png = failure.screenshot && (await readFile(failure.screenshot).catch(() => null))
    if (failure.screenshot && png) {
      try {
        return await upload(channelId, threadTs, text, failure.screenshot, png)
      } catch (err) {
        text += `\n_(screenshot not attached: ${(err as Error).message})_`
      }
    }
    await call('chat.postMessage', { channel: channelId, thread_ts: threadTs, text })
  }

  return {
    name: 'slack',
    async runFinished(report) {
      const summary = await call('chat.postMessage', { channel, text: summaryText(report) })
      // the answer has the channel's id, which file uploads need (SLACK_CHANNEL may be a name)
      const channelId = String(summary.channel)
      const threadTs = String(summary.ts)
      for (const failure of report.failures) await reply(channelId, threadTs, failure)
      if (report.moreFailures > 0) {
        const more = `…and ${report.moreFailures} more failed scenarios${report.url ? ` (<${report.url}|see all>)` : ''}`
        await call('chat.postMessage', { channel: channelId, thread_ts: threadTs, text: more })
      }
    },
  }
}

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
    `commit \`${run.commit.slice(0, 7)}\` · ${run.trigger}`,
    ...(flaky.length > 0 ? [`flaky: ${flaky.join(', ')}`] : []),
  ].join('\n')
}

function failureText({ scenarioId, device, error }: Failure) {
  const firstLine = error?.split('\n')[0] ?? 'no error message'
  return `:x: *${scenarioId}*${device ? ` on ${device}` : ''}\n\`\`\`${firstLine}\`\`\``
}
