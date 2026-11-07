import type { RunDetail } from '@nowait/shared'
import { duration, EmptyState, Table } from '../../ui/index.ts'
import { TimelineBlock } from '../../ui/TimelineBlock.tsx'

// One lane per phone, one block per attempt, from lease to result. The gaps are idle time: with the
// shared queue they stay small. A very big run shows its first blocks only (timelineCut), and the
// axis then ends where they end.
export function Timeline({ run }: { run: RunDetail }) {
  const start = run.createdAt.getTime()
  const runEnd = (run.finishedAt ?? run.now).getTime() // server clock only (R39)
  const end = run.timelineCut
    ? Math.max(...run.timeline.map((a) => (a.finishedAt ?? run.now).getTime()))
    : runEnd
  const total = Math.max(end - start, 1)
  const percent = (ms: number) => (ms / total) * 100
  const phones = [
    ...new Set([
      ...run.devices.map((d) => d.name), // every phone that finished work, even past the cut
      ...run.timeline.flatMap((a) => (a.device ? [a.device] : [])),
    ]),
  ].sort()

  if (phones.length === 0)
    return (
      <EmptyState
        title="No execution timeline yet"
        description="No phone has taken work for this run."
      />
    )
  return (
    <>
      <Table label="Execution timeline">
        <thead>
          <tr>
            <th>Phone</th>
            <th>Execution · 0s to {duration(total)}</th>
          </tr>
        </thead>
        <tbody>
          {phones.map((phone) => {
            const stats = run.devices.find((d) => d.name === phone)
            return (
              <tr key={phone}>
                <td>
                  {phone}
                  {/* busy share is known once the run is over */}
                  {stats && run.durationMs ? (
                    <span className="muted">
                      {' '}
                      {Math.round((stats.busyMs / run.durationMs) * 100)}% busy
                    </span>
                  ) : null}
                </td>
                <td>
                  <div className="lane-bar">
                    {run.timeline.map((a) => {
                      if (a.device !== phone || !a.leasedAt) return null
                      const from = a.leasedAt.getTime()
                      const to = a.finishedAt?.getTime() ?? end
                      const label = `${a.scenarioId}${a.profile ? ` [${a.profile.name}]` : ''}, attempt ${a.attempt}: ${a.status}, ${duration(to - from)}`
                      return (
                        <TimelineBlock
                          key={a.queueId}
                          left={percent(from - start)}
                          width={percent(to - from)}
                          status={a.status}
                          label={label}
                        />
                      )
                    })}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </Table>
      {run.timelineCut && (
        <p className="muted">
          Shows the first {run.timeline.length} attempts the phones took, up to {duration(total)}.
        </p>
      )}
    </>
  )
}
