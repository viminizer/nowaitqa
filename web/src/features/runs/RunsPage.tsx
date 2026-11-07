import { RunList } from '@nowait/shared'
import { type FormEvent, useState } from 'react'
import { useApi } from '../../lib/api.ts'
import { FilterTabs } from '../../ui/FilterTabs.tsx'
import { Form } from '../../ui/Form.tsx'
import { Icon } from '../../ui/Icon.tsx'
import {
  Button,
  Counts,
  DataPanel,
  duration,
  EmptyState,
  Input,
  Loaded,
  Page,
  Status,
  Summary,
  Table,
  TableFooter,
  time,
} from '../../ui/index.ts'
import { Link } from '../../ui/Link.tsx'
import { StartRun } from './StartRun.tsx'

// The URL owns committed filters/cursor; the form's unsubmitted draft stays local.
export function RunsPage({ params }: { params: URLSearchParams }) {
  const [creating, setCreating] = useState(false)
  const before = params.get('before')
  const status = params.get('status') ?? ''
  const search = params.get('q') ?? ''
  const query = new URLSearchParams({ limit: '10' })
  if (before) query.set('before', before)
  if (status) query.set('status', status)
  if (search) query.set('q', search)
  const state = useApi(`/runs?${query}`, RunList)
  const link = (nextStatus: string, cursor?: number) => {
    const next = new URLSearchParams()
    if (nextStatus) next.set('status', nextStatus)
    if (search) next.set('q', search)
    if (cursor !== undefined) next.set('before', String(cursor))
    return `#/${next.size ? `?${next}` : ''}`
  }
  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const next = new URLSearchParams()
    if (status) next.set('status', status)
    const value = String(new FormData(event.currentTarget).get('q') ?? '').trim()
    if (value) next.set('q', value)
    location.hash = `/${next.size ? `?${next}` : ''}`
  }
  return (
    <Page
      title="Runs"
      description="Your device queue, at a glance."
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" />
          Start run
        </Button>
      }
    >
      {creating && <StartRun onOpenChange={setCreating} />}
      <Loaded state={state}>
        {({ runs, older }) => (
          <>
            <Summary
              items={[
                { label: 'Running', value: runs.filter((run) => run.status === 'running').length },
                { label: 'Passed', value: runs.filter((run) => run.status === 'passed').length },
                { label: 'Failed', value: runs.filter((run) => run.status === 'failed').length },
                {
                  label: 'With flaky results',
                  value: runs.filter((run) => (run.counts.flaky ?? 0) > 0).length,
                },
              ]}
            />
            <DataPanel
              title={before ? 'Older runs' : 'Recent runs'}
              metadata={`${runs.length} runs · current page`}
              toolbar={
                <>
                  <FilterTabs
                    items={[
                      { label: 'All runs', href: link(''), active: status === '' },
                      { label: 'Running', href: link('running'), active: status === 'running' },
                      { label: 'Failed', href: link('failed'), active: status === 'failed' },
                      { label: 'Passed', href: link('passed'), active: status === 'passed' },
                    ]}
                  />
                  <Form layout="search" onSubmit={submitSearch} aria-label="Search all runs">
                    <Input
                      name="q"
                      type="search"
                      aria-label="Search all runs"
                      placeholder="Search runs…"
                      maxLength={200}
                      defaultValue={search}
                    />
                    <Button type="submit" variant="secondary">
                      Search
                    </Button>
                  </Form>
                </>
              }
            >
              {runs.length === 0 ? (
                <EmptyState
                  title={
                    search || status
                      ? 'No matching runs'
                      : before
                        ? 'No older runs'
                        : 'Your first run starts here'
                  }
                  description={
                    search || status
                      ? 'Try another status or search by run ID, build, commit, platform or trigger.'
                      : before
                        ? 'Return to the newest runs to continue.'
                        : 'Choose an Android or iOS Simulator build and send it to the device queue.'
                  }
                  action={(search || status) && <Link href="#/">Clear filters</Link>}
                />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th>Run</th>
                      <th>Result</th>
                      <th>Scenarios</th>
                      <th>Platform</th>
                      <th>Source</th>
                      <th>Started</th>
                      <th>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <tr key={run.id}>
                        <td>
                          <div className="run-context">
                            <Link variant="inline" href={`#/runs/${run.id}`}>
                              #{run.id}
                              <Icon name="arrow" />
                            </Link>
                            <span className="run-name">
                              {buildName(run.appBuild)}
                              {run.split === 'fixed' && ' · fixed'}
                            </span>
                          </div>
                          {run.launchId && (
                            <Link variant="inline" href={`#/launches/${run.launchId}`}>
                              Android + iOS launch
                            </Link>
                          )}
                        </td>
                        <td>
                          <div className="inline-result">
                            <Status status={run.status} />
                            {(run.counts.flaky ?? 0) > 0 && (
                              <Counts counts={{ flaky: run.counts.flaky ?? 0 }} />
                            )}
                          </div>
                        </td>
                        <td>
                          <Counts counts={run.counts} appearance="progress" />
                        </td>
                        <td>
                          <span className="platform-label">
                            <Icon name="phone" />
                            {run.platform === 'ios' ? 'iOS' : 'Android'}
                          </span>
                        </td>
                        <td>
                          <div className="run-source">
                            <code>{run.commit.slice(0, 7)}</code>
                            <span className="muted">{run.trigger}</span>
                          </div>
                        </td>
                        <td className="run-time">{time(run.createdAt)}</td>
                        <td>
                          <code>{duration(run.durationMs)}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              <TableFooter label={`${runs.length} runs on this page · newest first`}>
                {before && <Link href={link(status)}>Newest runs</Link>}
                {older !== null && <Link href={link(status, older)}>Older runs →</Link>}
              </TableFooter>
            </DataPanel>
            <footer className="page-footer">
              <span>Summary counts cover this page. Filters search all saved runs.</span>
              {runs[0] && (
                <Link href={`#/runs/${runs[0].id}`}>Open run #{runs[0].id} and evidence →</Link>
              )}
            </footer>
          </>
        )}
      </Loaded>
    </Page>
  )
}

function buildName(source: string) {
  // Credentials and signed query parameters never become row labels.
  if (source.includes('://')) {
    try {
      return new URL(source).pathname.split('/').filter(Boolean).at(-1) ?? 'Remote build'
    } catch {
      return 'App build'
    }
  }
  return source.split(/[\\/]/).filter(Boolean).at(-1) ?? 'App build'
}
