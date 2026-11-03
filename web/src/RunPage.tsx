import { type Attempt, countStatuses, RunDetail } from '@nowait/shared'
import { useApi } from './api.ts'
import { Timeline } from './Timeline.tsx'
import { Counts, duration, Loaded, Status, time } from './ui.tsx'

// Failures first: they are what people open a run for.
const ORDER: Record<Attempt['status'], number> = { failed: 0, leased: 1, pending: 2, passed: 3 }

// A finished run does not change any more.
const isRunning = (run: RunDetail) => run.status === 'running'

const file = (a: Attempt, name: 'screenshot' | 'log') =>
  `/dashboard/api/attempts/${a.queueId}/${name}`

// The first line of an error; the stack trace opens on a click.
function ErrorText({ error }: { error: string }) {
  const [first, ...stack] = error.split('\n')
  if (stack.length === 0) return first
  return (
    <details>
      <summary>{first}</summary>
      {stack.join('\n')}
    </details>
  )
}

export function RunPage({ id }: { id: number }) {
  const state = useApi(`/runs/${id}`, RunDetail, isRunning)
  return (
    <Loaded state={state}>
      {(run) => {
        const attempts = run.attempts.toSorted(
          (a, b) => ORDER[a.status] - ORDER[b.status] || a.queueId - b.queueId,
        )
        return (
          <>
            <h1>
              Run #{run.id} <Status status={run.status} />
            </h1>
            <dl className="facts">
              <dt>Scenarios</dt>
              <dd>
                <Counts counts={countStatuses(run.scenarios.map((s) => s.status))} />
              </dd>
              <dt>Started</dt>
              <dd>{time(run.createdAt)}</dd>
              <dt>Duration</dt>
              <dd>{duration(run.durationMs)}</dd>
              <dt>Platform</dt>
              <dd>{run.platform}</dd>
              <dt>Commit</dt>
              <dd>
                <code>{run.commit}</code>
              </dd>
              <dt>Trigger</dt>
              <dd>{run.trigger}</dd>
              <dt>Split</dt>
              <dd>{run.split}</dd>
              <dt>App build</dt>
              <dd>{run.appBuild}</dd>
            </dl>

            <h2>Phones</h2>
            <Timeline run={run} />

            <h2>Attempts</h2>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Scenario</th>
                    <th>Status</th>
                    <th>Phone</th>
                    <th>Duration</th>
                    <th>Error</th>
                    <th>Files</th>
                  </tr>
                </thead>
                <tbody>
                  {attempts.map((a) => (
                    <tr key={a.queueId}>
                      <td>
                        {a.scenarioId}
                        {a.attempt > 1 && <span className="muted"> retry {a.attempt - 1}</span>}
                      </td>
                      <td>
                        <Status status={a.status} />
                      </td>
                      <td>{a.device ?? '-'}</td>
                      <td>{duration(a.durationMs)}</td>
                      <td className="error-text">{a.error && <ErrorText error={a.error} />}</td>
                      <td className="files">
                        {a.screenshot && (
                          <a href={file(a, 'screenshot')} target="_blank" rel="noreferrer">
                            <img
                              src={file(a, 'screenshot')}
                              alt={`Screenshot of ${a.scenarioId}`}
                              loading="lazy"
                            />
                          </a>
                        )}
                        {a.log && (
                          <a href={file(a, 'log')} target="_blank" rel="noreferrer">
                            Log
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )
      }}
    </Loaded>
  )
}
