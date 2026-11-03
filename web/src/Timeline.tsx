import type { RunDetail } from '@nowait/shared'
import { duration } from './ui.tsx'

// One lane per phone, one block per attempt, from lease to result. The gaps are idle time: with the
// shared queue they stay small.
export function Timeline({ run }: { run: RunDetail }) {
  const start = run.createdAt.getTime()
  const end = (run.finishedAt ?? run.now).getTime() // server clock only (R39)
  const total = Math.max(end - start, 1)
  const percent = (ms: number) => `${(ms / total) * 100}%`
  const phones = [
    ...new Set(run.attempts.flatMap((a) => (a.leasedAt && a.device ? [a.device] : []))),
  ].sort()

  if (phones.length === 0) return <p className="muted">No phone has taken work yet.</p>
  return (
    <div className="timeline">
      {phones.map((phone) => {
        const stats = run.devices.find((d) => d.name === phone)
        return (
          <div className="lane" key={phone}>
            <div className="lane-name">
              {phone}
              {/* busy share is known once the run is over */}
              {stats && run.durationMs ? (
                <span className="muted">
                  {' '}
                  {Math.round((stats.busyMs / run.durationMs) * 100)}% busy
                </span>
              ) : null}
            </div>
            <div className="lane-bar">
              {run.attempts.map((a) => {
                if (a.device !== phone || !a.leasedAt) return null
                const from = a.leasedAt.getTime()
                const to = a.finishedAt?.getTime() ?? end
                const label = `${a.scenarioId}, attempt ${a.attempt}: ${a.status}, ${duration(to - from)}`
                return (
                  <div
                    key={a.queueId}
                    className={`block status-${a.status}`}
                    style={{ left: percent(from - start), width: percent(to - from) }}
                    title={label}
                    role="img"
                    aria-label={label}
                  />
                )
              })}
            </div>
          </div>
        )
      })}
      <div className="lane">
        <div />
        <div className="axis">
          <span>0s</span>
          <span>{duration(total)}</span>
        </div>
      </div>
    </div>
  )
}
