// Telegram, through the Bot API: a bot in a group with topics (a forum). Summaries go to one topic
// and failures to another, each by its message_thread_id, like Kevin's send-book bot. The bot must
// be a member of the group, allowed to post in those topics.
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { type Failure, type Notifier, PartialSendError, type RunReport } from './notifier.ts'
import { countsText, errorLine, escapeText, moreText } from './text.ts'

type Settings = {
  token: string
  chatId: string // the group, like -1001234567890
  runsTopic?: number // every run's summary; unset = the group's General topic
  errorsTopic?: number // each failed scenario; unset = replies to the summary
  apiUrl: string
}

const TIMEOUT_MS = 30_000 // per call; the job waits for the run, so a hung call can't block it
const RATE_LIMIT_TRIES = 3

type Answer = { ok?: boolean; description?: string; parameters?: { retry_after?: number } }

export function telegramNotifier(settings: Settings): Notifier {
  const { token, chatId, runsTopic, errorsTopic, apiUrl } = settings

  // Telegram answers { ok: false, description } when a call fails, and 429 with
  // parameters.retry_after when it is rate limited: then it waits and tries again. The token is
  // in the URL, so errors never show the URL.
  async function call(method: string, body: Record<string, unknown> | FormData) {
    for (let tries = 1; ; tries++) {
      const res = await fetch(`${apiUrl}/bot${token}/${method}`, {
        method: 'POST',
        ...(body instanceof FormData
          ? { body }
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const data = (await res.json().catch(() => ({}))) as Answer & { result?: unknown }
      if (res.status === 429 && tries < RATE_LIMIT_TRIES) {
        await sleep(Math.min(data.parameters?.retry_after ?? 1, 30) * 1000)
        continue
      }
      if (!data.ok)
        throw new Error(`telegram ${method}: ${data.description ?? `HTTP ${res.status}`}`)
      return data.result as { message_id: number }
    }
  }

  const topic = (id?: number) => ({ chat_id: chatId, ...(id ? { message_thread_id: id } : {}) })

  // A photo with the failure as its caption. When the file is gone or the upload fails, a text
  // message with the reason.
  async function sendFailure(where: Record<string, unknown>, text: string, failure: Failure) {
    const html = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }
    if (failure.screenshot) {
      const path = failure.screenshot
      try {
        const png = await readFile(path).catch((err) => {
          throw new Error(`the file is gone (${err.code ?? err.message})`)
        })
        const form = new FormData()
        for (const [key, value] of Object.entries({
          ...where,
          caption: text,
          parse_mode: 'HTML',
        })) {
          form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
        }
        form.append('photo', new Blob([png], { type: 'image/png' }), basename(path))
        return await call('sendPhoto', form)
      } catch (err) {
        text += `\n<i>(screenshot not attached: ${escapeText((err as Error).message)})</i>`
      }
    }
    return call('sendMessage', { ...where, ...html, text })
  }

  return {
    name: 'telegram',
    async runFinished(report) {
      const summary = await call('sendMessage', {
        ...topic(runsTopic),
        text: summaryHtml(report),
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      })
      // From here the run is in the group: a failed detail must not post it again.
      try {
        // the errors topic, or replies to the summary when there is none
        const where = errorsTopic
          ? topic(errorsTopic)
          : { ...topic(runsTopic), reply_parameters: { message_id: summary.message_id } }
        for (const failure of report.failures) {
          await sendFailure(where, failureHtml(report, failure), failure)
        }
        if (report.moreFailures > 0) {
          const link = report.url ? ` (<a href="${attr(report.url)}">see all</a>)` : ''
          await call('sendMessage', {
            ...where,
            text: `${moreText(report.moreFailures)} in ${runTitle(report)}${link}`,
            parse_mode: 'HTML',
          })
        }
      } catch (err) {
        throw new PartialSendError(`the failures are incomplete: ${(err as Error).message}`)
      }
    },
  }
}

const attr = (text: string) => escapeText(text).replaceAll('"', '&quot;')

// "Run #5" as a link to the dashboard when PUBLIC_URL is set
const runTitle = ({ run, url }: RunReport) =>
  url ? `<a href="${attr(url)}">Run #${run.id}</a>` : `Run #${run.id}`

function summaryHtml(report: RunReport) {
  const { run, flaky } = report
  const icon = run.status === 'passed' ? '✅' : '❌'
  return [
    `${icon} <b>${runTitle(report)} ${run.status}</b> · ${run.platform} · ${countsText(report)}`,
    `commit <code>${run.commit.slice(0, 7)}</code> · ${escapeText(run.trigger)}`,
    ...(flaky.length > 0 ? [`flaky: ${escapeText(flaky.join(', '))}`] : []),
  ].join('\n')
}

// Each failure names its run: in the errors topic it is not next to the summary.
function failureHtml(report: RunReport, { scenarioId, device, error }: Failure) {
  const where = device ? ` on ${escapeText(device)}` : ''
  return [
    `❌ <b>${escapeText(scenarioId)}</b>${where} · ${runTitle(report)}`,
    `<code>${escapeText(errorLine(error))}</code>`,
  ].join('\n')
}
