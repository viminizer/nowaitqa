import { RunList } from '@nowait/shared'
import { useApi } from './api.ts'
import { Counts, duration, Loaded, Status, time } from './ui.tsx'

export function RunsPage({ before }: { before: string | null }) {
  const state = useApi(before ? `/runs?before=${before}` : '/runs', RunList)
  return (
    <>
      <h1>Runs</h1>
      <Loaded state={state}>
        {({ runs, older }) =>
          runs.length === 0 ? (
            <p className="muted">
              {before ? (
                'No older runs.'
              ) : (
                <>
                  No runs yet. Start one with <code>POST /runs</code> (Jenkins does this).
                </>
              )}
            </p>
          ) : (
            <>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>Status</th>
                      <th>Scenarios</th>
                      <th>Platform</th>
                      <th>Commit</th>
                      <th>Trigger</th>
                      <th>Started</th>
                      <th>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <tr key={run.id}>
                        <td>
                          <a href={`#/runs/${run.id}`}>#{run.id}</a>
                          {run.split === 'fixed' && <span className="muted"> fixed</span>}
                        </td>
                        <td>
                          <Status status={run.status} />
                        </td>
                        <td>
                          <Counts counts={run.counts} />
                        </td>
                        <td>{run.platform}</td>
                        <td>
                          <code>{run.commit.slice(0, 7)}</code>
                        </td>
                        <td>{run.trigger}</td>
                        <td>{time(run.createdAt)}</td>
                        <td>{duration(run.durationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="pager">
                {before && <a href="#/">Newest runs</a>}
                {older && <a href={`#/?before=${older}`}>Older runs</a>}
              </p>
            </>
          )
        }
      </Loaded>
    </>
  )
}
