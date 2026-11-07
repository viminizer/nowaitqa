import { countStatuses, LaunchDetail } from '@nowait/shared'
import { useApi } from '../../lib/api.ts'
import {
  Counts,
  DataPanel,
  Link,
  Loaded,
  Page,
  Status,
  Summary,
  Table,
  time,
} from '../../ui/index.ts'

export function LaunchPage({ id }: { id: string }) {
  const state = useApi(`/launches/${id}`, LaunchDetail, (launch) => launch.status === 'running')
  return (
    <Page
      title={<>Launch {state.data && <Status status={state.data.status} />}</>}
      description="Android and iOS, with independent results."
      actions={<Link href="#/">All runs</Link>}
    >
      {state.data && (
        <Summary
          label="Launch platform summary"
          items={[
            { label: 'Platforms', value: state.data.runs.length },
            {
              label: 'Running',
              value: state.data.runs.filter((r) => r.status === 'running').length,
            },
            { label: 'Passed', value: state.data.runs.filter((r) => r.status === 'passed').length },
            { label: 'Failed', value: state.data.runs.filter((r) => r.status === 'failed').length },
          ]}
        />
      )}
      <DataPanel
        title="Platform runs"
        description="A launch is release-ready only when both platform release gates accept. Retrying a child run creates separate history."
        metadata={
          state.data && (
            <>
              Release gate <Status status={state.data.releaseStatus} />
            </>
          )
        }
      >
        <Loaded state={state}>
          {(launch) => (
            <Table label="Launch platforms">
              <thead>
                <tr>
                  <th>Platform / run</th>
                  <th>Result</th>
                  <th>Scenarios</th>
                  <th>Release gate</th>
                  <th>Build</th>
                  <th>Started</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {launch.runs.map((run) => (
                  <tr key={run.id}>
                    <td>
                      {run.platform === 'ios' ? 'iOS Simulator' : 'Android'}{' '}
                      <Link variant="inline" href={`#/runs/${run.id}`}>
                        #{run.id}
                      </Link>
                    </td>
                    <td>
                      <Status status={run.status} />
                    </td>
                    <td>
                      <Counts counts={countStatuses(run.scenarios.map((s) => s.status))} />
                    </td>
                    <td>
                      {run.release ? (
                        <>
                          <Status status={run.release.gate.status} />
                          <p>{run.release.gate.policy} policy</p>
                        </>
                      ) : (
                        'Unavailable'
                      )}
                    </td>
                    <td>{run.inputManifest.intent?.appSource ?? 'Build source unavailable'}</td>
                    <td>{time(run.createdAt)}</td>
                    <td>
                      <Link href={`#/runs/${run.id}`}>Open run and evidence</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Loaded>
      </DataPanel>
      {state.data && (
        <footer className="page-footer">
          <span>
            Scenario commit <code>{state.data.runs[0]?.commit}</code>
          </span>
          <span>Created {time(state.data.createdAt)}</span>
        </footer>
      )}
    </Page>
  )
}
