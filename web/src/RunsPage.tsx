import { RunList } from '@nowait/shared'
import type { FormEvent } from 'react'
import { useAction, useApi } from './api.ts'
import { ActionError, Counts, duration, Loaded, openRun, Status, time } from './ui.tsx'

function StartRun() {
  const action = useAction()
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (action.isPending) return
    const fields = new FormData(event.currentTarget)
    action.mutate(
      {
        path: '/runs',
        body: {
          platform: fields.get('platform'),
          appBuild: String(fields.get('appBuild') ?? '').trim(),
        },
      },
      { onSuccess: openRun },
    )
  }
  return (
    <form
      className="action-form"
      onSubmit={submit}
      aria-labelledby="start-run-title"
      aria-busy={action.isPending}
    >
      <h2 id="start-run-title">Start run</h2>
      <fieldset disabled={action.isPending}>
        <label htmlFor="start-platform">
          Platform
          <select id="start-platform" name="platform" defaultValue="android">
            <option value="android">Android</option>
            <option value="ios">iOS Simulator</option>
          </select>
        </label>
        <label htmlFor="start-build">
          App build URL or path
          <input
            id="start-build"
            name="appBuild"
            type="text"
            required
            pattern=".*\S.*"
            title="Enter an app build URL or path."
            autoComplete="off"
            placeholder="/builds/app.apk or https://example.com/app.zip"
            aria-describedby="start-build-help"
          />
        </label>
        <span className="action">
          <button type="submit">{action.isPending ? 'Starting…' : 'Start run'}</button>
        </span>
      </fieldset>
      <p className="muted" id="start-build-help">
        Android: .apk. iOS Simulator: .app or zipped .app. Paths are on the Appium host. Uses the
        latest scenarios available from a runner.
      </p>
      <ActionError error={action.error} />
    </form>
  )
}

export function RunsPage({ before }: { before: string | null }) {
  const state = useApi(before ? `/runs?before=${before}` : '/runs', RunList)
  return (
    <>
      <h1>Runs</h1>
      <StartRun />
      <h2>{before ? 'Older runs' : 'Recent runs'}</h2>
      <Loaded state={state}>
        {({ runs, older }) =>
          runs.length === 0 ? (
            <p className="muted">{before ? 'No older runs.' : 'No runs yet. Start one above.'}</p>
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
