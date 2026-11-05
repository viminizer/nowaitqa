import { ScenarioHistoryPage } from '@nowait/shared'
import type { FormEvent } from 'react'
import { useApi } from './api.ts'
import { Loaded, time } from './ui.tsx'

function HistoryResults({ params }: { params: URLSearchParams }) {
  const state = useApi(`/history?${params}`, ScenarioHistoryPage)
  const link = (until: Date, after?: string) => {
    const next = new URLSearchParams(params)
    next.set('until', until.toISOString())
    if (after) next.set('after', after)
    else next.delete('after')
    return `#/history?${next}`
  }
  return (
    <Loaded state={state}>
      {({ from, until, entries, next }) => (
        <>
          <p className="muted">
            Finished runs from {time(from)} to {time(until)}. Each row is a separate
            input/profile/runtime cohort across this whole window; pages do not change its
            denominator.
          </p>
          {entries.length === 0 ? (
            <p className="muted">No completed samples in this window.</p>
          ) : (
            <div className="scroll">
              <table>
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
                          <a href={`#/runs/${c.latestRunId}`}>Latest run #{c.latestRunId}</a>
                          <p>
                            {time(c.firstObserved)} – {time(c.lastObserved)}
                          </p>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="pager">
            {params.has('after') && <a href={link(until)}>First page</a>}
            {next && <a href={link(until, next)}>More cohorts</a>}
          </p>
        </>
      )}
    </Loaded>
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
  return (
    <>
      <h1>Scenario reliability</h1>
      <form className="action-form" onSubmit={submit} aria-label="Reliability history filters">
        <fieldset>
          <label htmlFor="history-scenario">
            Scenario ID
            <input
              id="history-scenario"
              name="scenarioId"
              required
              defaultValue={params.get('scenarioId') ?? ''}
            />
          </label>
          <label htmlFor="history-platform">
            Platform
            <select
              id="history-platform"
              name="platform"
              defaultValue={params.get('platform') ?? 'android'}
            >
              <option value="android">Android</option>
              <option value="ios">iOS Simulator</option>
            </select>
          </label>
          <label htmlFor="history-days">
            Window
            <select id="history-days" name="days" defaultValue={params.get('days') ?? '30'}>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </select>
          </label>
          <span className="action">
            <button type="submit">Show history</button>
          </span>
        </fieldset>
      </form>
      {params.has('scenarioId') && params.has('platform') ? (
        <HistoryResults params={params} />
      ) : (
        <p className="muted">Choose a scenario and platform to compare its completed samples.</p>
      )}
    </>
  )
}
