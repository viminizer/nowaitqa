import { FixturePage, fixtureReasonText } from '@nowait/shared'
import { useApi } from '../../lib/api.ts'
import {
  Action,
  DataPanel,
  EmptyState,
  Loaded,
  Page,
  Status,
  Summary,
  Table,
  TableFooter,
  time,
} from '../../ui/index.ts'
import { Link } from '../../ui/Link.tsx'

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
    <Page
      title={queueId ? `Fixtures for attempt #${queueId}` : 'Fixtures'}
      description="Managed resources and cleanup recovery."
    >
      {state.data && (
        <Summary
          items={['pending', 'cleaning', 'quarantined', 'cleaned'].map((status) => ({
            label:
              status === 'pending'
                ? 'Pending cleanup'
                : status === 'cleaning'
                  ? 'Cleaning'
                  : status === 'quarantined'
                    ? 'Quarantined'
                    : 'Verified clean',
            value: state.data.fixtures.filter((f) => f.status === status).length,
          }))}
        />
      )}
      <DataPanel
        title={queueId ? 'Attempt fixtures' : 'Awaiting cleanup'}
        description="Accounts stay unavailable until every managed resource is verified clean. Cleanup health is separate from the scenario result."
        metadata={state.data && `${state.data.fixtures.length} fixtures · current page`}
      >
        <Loaded state={state}>
          {({ fixtures, next }) => (
            <>
              {fixtures.length === 0 ? (
                <EmptyState
                  title={queueId ? 'No retained fixture records' : 'No fixtures awaiting cleanup'}
                  description={
                    queueId
                      ? 'This attempt has no retained managed-resource records.'
                      : 'There are no pending cleanup records to review.'
                  }
                />
              ) : (
                <Table>
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
                          <Link variant="inline" href={`#/runs/${f.runId}`}>
                            Run #{f.runId}
                          </Link>
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
                </Table>
              )}
              <TableFooter label={`${fixtures.length} fixtures on this page`}>
                {after && <Link href={page()}>First page</Link>}
                {next !== null && <Link href={page(next)}>Older fixtures</Link>}
              </TableFooter>
            </>
          )}
        </Loaded>
      </DataPanel>
      <footer className="page-footer">Summary counts cover this page.</footer>
    </Page>
  )
}
