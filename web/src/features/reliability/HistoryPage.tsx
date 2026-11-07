import { ScenarioHistoryPage } from '@nowait/shared'
import type { FormEvent, ReactNode } from 'react'
import { useApi } from '../../lib/api.ts'
import { Form } from '../../ui/Form.tsx'
import {
  Button,
  DataPanel,
  EmptyState,
  Input,
  Loaded,
  Page,
  Summary,
  Table,
  TableFooter,
  time,
} from '../../ui/index.ts'
import { Link } from '../../ui/Link.tsx'
import { Select } from '../../ui/Select.tsx'

function HistoryResults({ params, toolbar }: { params: URLSearchParams; toolbar: ReactNode }) {
  const state = useApi(`/history?${params}`, ScenarioHistoryPage)
  const link = (until: Date, after?: string) => {
    const next = new URLSearchParams(params)
    next.set('until', until.toISOString())
    if (after) next.set('after', after)
    else next.delete('after')
    return `#/history?${next}`
  }
  return (
    <>
      {state.data && (
        <Summary
          items={[
            { label: 'Cohorts', value: state.data.entries.length },
            {
              label: 'Verified identity',
              value: state.data.entries.filter((c) => c.comparable).length,
            },
            { label: 'Isolated', value: state.data.entries.filter((c) => !c.comparable).length },
            {
              label: 'Linked runs',
              value: new Set(state.data.entries.map((c) => c.latestRunId)).size,
            },
          ]}
        />
      )}
      <DataPanel
        title="Reliability cohorts"
        toolbar={toolbar}
        metadata={state.data && `${state.data.entries.length} cohorts · current page`}
        description={
          state.data
            ? `Finished runs from ${time(state.data.from)} to ${time(state.data.until)}. Each row is a separate input/profile/runtime cohort across this whole window; pages do not change its denominator.`
            : 'Compare completed samples with matching inputs, profiles and runtime.'
        }
      >
        <Loaded state={state}>
          {({ until, entries, next }) => (
            <>
              {entries.length === 0 ? (
                <EmptyState
                  title="No completed samples"
                  description="Try another scenario, platform or time window."
                />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th>Cohort</th>
                      <th>First application pass</th>
                      <th>Recovery and failures</th>
                      <th>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((c) => {
                      const applicationSamples =
                        c.firstPass + c.laterPass + c.applicationFailure + c.interruptedApplication
                      return (
                        <tr key={c.key}>
                          <td>
                            <code>{c.key}</code>
                            <p>
                              {c.profile?.name ?? 'Shared device queue'} · {c.split} ·{' '}
                              {c.partialCoverage ? 'subset rerun' : 'full run'}
                            </p>
                            <p>
                              {c.comparable
                                ? 'Verified identity'
                                : 'Incomplete or mixed identity; isolated to this run'}
                            </p>
                            <details>
                              <summary>Inputs and runtime</summary>
                              <p>
                                {c.recovery
                                  ? `${c.recovery.maxAttempts} application attempts; ${c.recovery.maxInfrastructureRecoveries} slot / ${c.recovery.maxRunInfrastructureRecoveries} run infrastructure recoveries`
                                  : 'Legacy recovery limits unavailable'}
                              </p>
                              <p>
                                Commit: <code>{c.commit}</code>
                              </p>
                              <p>
                                App SHA256: <code>{c.inputs?.app.sha256 ?? 'unknown'}</code>
                              </p>
                              <p>
                                Scenario tree: <code>{c.inputs?.scenarios.tree ?? 'unknown'}</code>
                              </p>
                              <p>
                                Dependency lock:{' '}
                                <code>{c.inputs?.scenarios.lockSha256 ?? 'unavailable'}</code>
                              </p>
                              <p>
                                {c.inputs
                                  ? `${c.inputs.config.sessionMode}; ${c.inputs.config.scenarioTimeoutSeconds}s deadline`
                                  : 'Legacy/unverified configuration'}
                              </p>
                              <p>
                                Runtime: {c.runtimeState}
                                {c.runtime &&
                                  `; OS ${c.runtime.platformVersion ?? 'unknown'}, ${c.runtime.deviceClass ?? c.runtime.automation ?? 'unknown'}, runner ${c.runtime.runner}`}
                              </p>
                              <p>
                                Profile:{' '}
                                {c.profile
                                  ? `${c.profile.deviceClass} ${c.profile.platformVersion}`
                                  : 'not required'}
                              </p>
                            </details>
                          </td>
                          <td>
                            {c.comparable && applicationSamples > 0
                              ? `${((100 * c.firstPass) / applicationSamples).toFixed(1)}% (${c.firstPass}/${applicationSamples})`
                              : 'Rate unavailable'}
                            <p>
                              {c.samples} total samples; {c.infrastructureOnly} infrastructure-only,{' '}
                              {c.unknown} unknown excluded from application denominator.
                            </p>
                          </td>
                          <td>
                            <p>
                              {c.laterPass} later application passes · {c.applicationFailure}{' '}
                              exhausted application failures
                            </p>
                            <p>
                              {c.infrastructureInterruptions} infrastructure interruptions across
                              attempts
                            </p>
                            <p>
                              {c.interruptedApplication} application failures with interrupted
                              recovery (included in denominator)
                            </p>
                            <p>{c.rawFlaky} raw flaky samples (preserved)</p>
                          </td>
                          <td>
                            <Link variant="inline" href={`#/runs/${c.latestRunId}`}>
                              Latest run #{c.latestRunId}
                            </Link>
                            <p>
                              {time(c.firstObserved)} – {time(c.lastObserved)}
                            </p>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </Table>
              )}
              <TableFooter label={`${entries.length} cohorts on this page`}>
                {params.has('after') && <Link href={link(until)}>First page</Link>}
                {next && <Link href={link(until, next)}>More cohorts</Link>}
              </TableFooter>
            </>
          )}
        </Loaded>
      </DataPanel>
      <footer className="page-footer">
        Summary counts cover this page. Cohort rates cover the whole selected window.
      </footer>
    </>
  )
}

export function HistoryPage({ params }: { params: URLSearchParams }) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    const query = new URLSearchParams()
    for (const key of ['scenarioId', 'platform', 'days'])
      query.set(key, String(fields.get(key) ?? ''))
    location.hash = `/history?${query}`
  }
  const toolbar = (
    <Form layout="filters" onSubmit={submit} aria-label="Reliability history filters">
      <fieldset>
        <label htmlFor="history-scenario">
          Scenario ID
          <Input
            id="history-scenario"
            name="scenarioId"
            required
            defaultValue={params.get('scenarioId') ?? ''}
          />
        </label>
        <label htmlFor="history-platform">
          Platform
          <Select
            id="history-platform"
            name="platform"
            defaultValue={params.get('platform') ?? 'android'}
            label="Platform"
            options={[
              { value: 'android', label: 'Android' },
              { value: 'ios', label: 'iOS Simulator' },
            ]}
          />
        </label>
        <label htmlFor="history-days">
          Window
          <Select
            id="history-days"
            name="days"
            defaultValue={params.get('days') ?? '30'}
            label="Window"
            options={[
              { value: '7', label: '7 days' },
              { value: '30', label: '30 days' },
              { value: '90', label: '90 days' },
            ]}
          />
        </label>
        <span className="action">
          <Button type="submit" variant="primary">
            Show history
          </Button>
        </span>
      </fieldset>
    </Form>
  )
  return (
    <Page title="Reliability" description="Compare like-for-like scenario results.">
      {params.has('scenarioId') && params.has('platform') ? (
        <HistoryResults params={params} toolbar={toolbar} />
      ) : (
        <DataPanel
          title="Reliability cohorts"
          description="Each cohort keeps its own inputs, runtime and application denominator."
          toolbar={toolbar}
        >
          <EmptyState
            title="Choose a scenario"
            description="Select a scenario and platform to compare its completed samples."
          />
        </DataPanel>
      )}
    </Page>
  )
}
