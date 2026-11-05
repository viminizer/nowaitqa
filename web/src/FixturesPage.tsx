import { FixturePage, fixtureReasonText } from '@nowait/shared'
import { useApi } from './api.ts'
import { Action, Loaded, Status, time } from './ui.tsx'

export function FixturesPage({ after, queueId }: { after: string | null; queueId: string | null }) {
  const query = new URLSearchParams()
  if (after) query.set('after', after)
  if (queueId) query.set('queueId', queueId)
  const state = useApi(`/fixtures?${query}`, FixturePage)
  const page = (next?: number) => {
    const params = new URLSearchParams()
    if (queueId) params.set('queueId', queueId)
    if (next) params.set('after', String(next))
    return `#/fixtures?${params}`
  }
  return (
    <>
      <h1>{queueId ? `Fixtures for attempt #${queueId}` : 'Fixtures awaiting cleanup'}</h1>
      <p className="muted">
        Accounts stay unavailable until every managed resource is verified clean. Cleanup health is
        separate from the scenario result.
      </p>
      <Loaded state={state}>
        {({ fixtures, next }) => (
          <>
            {fixtures.length === 0 ? (
              <p className="muted">
                {queueId ? 'No retained fixture records.' : 'No fixtures awaiting cleanup.'}
              </p>
            ) : (
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Fixture</th>
                      <th>Attempt</th>
                      <th>State</th>
                      <th>Cleanup</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fixtures.map((f) => (
                      <tr key={f.id}>
                        <td>
                          {f.name}
                          <p className="muted">
                            <code>{f.key}</code>
                          </p>
                        </td>
                        <td>
                          <a href={`#/runs/${f.runId}`}>Run #{f.runId}</a>
                          <p>
                            {f.scenarioId} · attempt #{f.queueId}
                          </p>
                          <p className="muted">{f.device ?? 'Phone unknown'}</p>
                        </td>
                        <td>
                          <Status status={f.status} />
                          <p>{fixtureReasonText(f.reason)}</p>
                          <p className="muted">
                            {f.accountHeld ? 'Account held' : 'No account held'}
                          </p>
                        </td>
                        <td>
                          <p>
                            {f.attempts} cleanup attempts · {time(f.updatedAt)}
                          </p>
                          {f.canRetry && (
                            <Action
                              label="Retry cleanup"
                              path={`/fixtures/${f.id}/retry`}
                              body={{ confirmedStopped: true }}
                              ask="Confirm that the old runner, scenario and cleanup processes, Appium session, and accepted backend operations have stopped. Retry this fixture's cleanup?"
                            />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="pager">
              {after && <a href={page()}>First page</a>}
              {next !== null && <a href={page(next)}>Older fixtures</a>}
            </p>
          </>
        )}
      </Loaded>
    </>
  )
}
