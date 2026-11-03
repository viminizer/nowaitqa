// Telegram, through the Bot API: a bot in a group with topics (a forum). Summaries go to one topic
// and failures to another, each by its message_thread_id, like Kevin's send-book bot. The bot must
// be a member of the group, allowed to post in those topics.
import { setTimeout as sleep } from 'node:timers/promises'
import { messageOf } from '../errors.ts'
import { post, sendScreenshot } from './http.ts'
import { type Failure, type Notifier, PartialSendError, type RunReport } from './notifier.ts'
import { countsText, errorLine, escapeText, moreText } from './text.ts'

type Settings = {
  token: string
  chatId: string // the group, like -1001234567890
  runsTopic?: number // every run's summary; unset = the group's General topic
  errorsTopic?: number // each failed scenario; unset = replies to the summary
  apiUrl: string // https://api.telegram.org, or a self-hosted Bot API server
}

// A group takes about 20 messages a minute: keep a gap, so a burst of runs is not refused.
// ponytail: one gap per notifier, so one group; per-chat gaps if it ever posts to several.
const GAP_MS = 3_000
const CAPTION_CHARS = 500 // of the error line; a photo caption holds 1024 characters in all

// Every text message: HTML, and no preview card for the dashboard link.
const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }

export function telegramNotifier(settings: Settings): Notifier {
  const { token, chatId, runsTopic, errorsTopic, apiUrl } = settings
  let lastCall = 0

  // Telegram answers { ok: false, description } when a call fails. The token is in the URL, so
  // errors never show the URL.
  async function call(method: string, body: Record<string, unknown> | FormData) {
    const wait = lastCall + GAP_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastCall = Date.now()
    const { status, data } = await post(
      `${apiUrl}/bot${token}/${method}`,
      body instanceof FormData
        ? { body }
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    )
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? `HTTP ${status}`}`)
    return data.result as { message_id: number }
  }

  const topic = (id?: number) => ({ chat_id: chatId, ...(id ? { message_thread_id: id } : {}) })

  // A photo with the failure as its caption, or text with the reason the photo is missing.
  async function sendFailure(where: Record<string, unknown>, failure: Failure, run: RunReport) {
    const text = failureHtml(run, failure)
    const shot = await sendScreenshot(failure.screenshot, (png, filename) => {
      const form = new FormData()
      for (const [key, value] of Object.entries({ ...where, caption: text, parse_mode: 'HTML' })) {
        form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
      }
      form.append('photo', new Blob([png], { type: 'image/png' }), filename)
      return call('sendPhoto', form)
    })
    if (shot.sent) return
    const why = shot.reason ? `\n<i>(screenshot not attached: ${escapeText(shot.reason)})</i>` : ''
    await call('sendMessage', { ...where, ...HTML, text: text + why })
  }

  return {
    name: 'telegram',
    async runFinished(report) {
      const summary = await call('sendMessage', {
        ...topic(runsTopic),
        ...HTML,
        text: summaryHtml(report),
      })
      // From here the run is in the group: a failed detail must not post it again.
      try {
        // the errors topic, or replies to the summary when there is none
        const where = errorsTopic
          ? topic(errorsTopic)
          : { ...topic(runsTopic), reply_parameters: { message_id: summary.message_id } }
        for (const failure of report.failures) await sendFailure(where, failure, report)
        if (report.moreFailures > 0) {
          const link = report.url ? ` (<a href="${attr(report.url)}">see all</a>)` : ''
          const text = `${moreText(report.moreFailures)} in ${runTitle(report)}${link}`
          await call('sendMessage', { ...where, ...HTML, text })
        }
      } catch (err) {
        throw new PartialSendError(`the failures are incomplete: ${messageOf(err)}`)
      }
    },
  }
}

const attr = (text: string) => escapeText(text).replaceAll('"', '&quot;')

// Cut by characters, not UTF-16 units, so an emoji is never split.
function cut(text: string, max: number) {
  const chars = [...text]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text
}

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
    `<code>${escapeText(cut(errorLine(error), CAPTION_CHARS))}</code>`,
  ].join('\n')
}
