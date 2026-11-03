import { messageOf } from '@nowait/shared'
// Slack, through the Web API with a bot token: a webhook can't post in threads or upload files.
// The app needs the chat:write and files:write scopes, and must be in the channel.
import { post, sendScreenshot } from './http.ts'
import { type Failure, type Notifier, PartialSendError, type RunReport } from './notifier.ts'
import { countsText, errorLine, escapeText, moreText } from './text.ts'

// apiUrl: https://slack.com/api, or https://slack-gov.com/api for GovSlack.
type Settings = { token: string; channel: string; apiUrl: string }

export function slackNotifier({ token, channel, apiUrl }: Settings): Notifier {
  // Slack answers 200 with { ok: false, error } when a call fails.
  async function call(method: string, body: Record<string, unknown>, form = false) {
    const { status, data } = await post(`${apiUrl}/${method}`, {
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
      },
      body: form
        ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]))
        : JSON.stringify(body),
    })
    if (!data.ok) throw new Error(`slack ${method}: ${data.error ?? `HTTP ${status}`}`)
    return data
  }

  async function upload(
    channelId: string,
    threadTs: string,
    text: string,
    png: Buffer<ArrayBuffer>,
    filename: string,
  ) {
    const { upload_url, file_id } = await call(
      'files.getUploadURLExternal',
      { filename, length: png.length },
      true,
    )
    const { status } = await post(String(upload_url), { body: png })
    if (status >= 300) throw new Error(`slack upload: HTTP ${status}`)
    await call('files.completeUploadExternal', {
      files: [{ id: file_id, title: filename }],
      channel_id: channelId,
      thread_ts: threadTs,
      initial_comment: text,
    })
  }

  // A thread reply with the screenshot, or text with the reason it is missing.
  async function reply(channelId: string, threadTs: string, failure: Failure) {
    const text = failureText(failure)
    const shot = await sendScreenshot(failure.screenshot, (png, filename) =>
      upload(channelId, threadTs, text, png, filename),
    )
    if (shot.sent) return
    const why = shot.reason ? `\n_(screenshot not attached: ${escapeText(shot.reason)})_` : ''
    await call('chat.postMessage', { channel: channelId, thread_ts: threadTs, text: text + why })
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
          const text = `${moreText(report.moreFailures)}${link}`
          await call('chat.postMessage', { channel: channelId, thread_ts: threadTs, text })
        }
      } catch (err) {
        throw new PartialSendError(`the thread is incomplete: ${messageOf(err)}`)
      }
    },
  }
}

function summaryText(report: RunReport) {
  const { run, url, flaky } = report
  const icon = run.status === 'passed' ? ':white_check_mark:' : ':x:'
  const title = url ? `<${url}|Run #${run.id}>` : `Run #${run.id}`
  return [
    `${icon} *${title} ${run.status}* · ${run.platform} · ${countsText(report)}`,
    `commit \`${run.commit.slice(0, 7)}\` · ${escapeText(run.trigger)}`,
    ...(flaky.length > 0 ? [`flaky: ${escapeText(flaky.join(', '))}`] : []),
  ].join('\n')
}

function failureText({ scenarioId, device, error }: Failure) {
  // backticks would end the code block early
  const line = errorLine(error).replaceAll('`', "'")
  const where = device ? ` on ${escapeText(device)}` : ''
  return `:x: *${escapeText(scenarioId)}*${where}\n\`\`\`${escapeText(line)}\`\`\``
}
