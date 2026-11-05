import {
  type Attempt,
  AttemptPage,
  countStatuses,
  inputSource,
  originText,
  RunDetail,
  releaseReasonText,
  stageText,
} from '@nowait/shared'
import { useApi } from './api.ts'
import { Timeline } from './Timeline.tsx'
import { Action, Counts, duration, Loaded, openRun, Status, time } from './ui.tsx'

// A finished run does not change any more.
const isRunning = (run: RunDetail) => run.status === 'running'
const needsAttemptRefresh = (page: AttemptPage) =>
  page.runStatus === 'running' ||
  page.attempts.some((a) => a.fixtureCleanup === 'pending' || a.fixtureCleanup === 'quarantined')

const file = (a: Attempt, name: 'screenshot' | 'log' | 'diagnostics') =>
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

// One page of the run's attempts. The server sorts them: failures first once the run is over.
function Attempts({
  runId,
  page,
  platform,
}: {
  runId: number
  page: number
  platform?: 'android' | 'ios'
}) {
  const state = useApi(`/runs/${runId}/attempts?page=${page}`, AttemptPage, needsAttemptRefresh)
  return (
    <Loaded state={state}>
      {({ attempts, next, runStatus }) =>
        attempts.length === 0 ? (
          <p className="muted">
            {page > 0 ? (
              <>
                No more attempts. <a href={`#/runs/${runId}`}>First page</a>
              </>
            ) : (
              'No attempts yet.'
            )}
          </p>
        ) : (
          <>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Scenario</th>
                    <th>Status</th>
                    <th>Phone</th>
                    <th>Duration</th>
                    <th>Execution</th>
                    <th>Recovery</th>
                    <th>Error</th>
                    <th>Files</th>
                  </tr>
                </thead>
                <tbody>
                  {attempts.map((a) => (
                    <tr key={a.queueId}>
                      <td>
                        {platform ? (
                          <a
                            href={`#/history?scenarioId=${encodeURIComponent(a.scenarioId)}&platform=${platform}`}
                          >
                            {a.scenarioId}
                          </a>
                        ) : (
                          a.scenarioId
                        )}
                        {a.profile && (
                          <p className="muted">
                            {a.profile.name} · {a.profile.deviceClass} {a.profile.platformVersion}
                          </p>
                        )}
                        <p className="muted">
                          #{a.queueId} · attempt {a.attempt}
                          {a.scenarioAttempt !== null && <> · test attempt {a.scenarioAttempt}</>}
                        </p>
                      </td>
                      <td>
                        <Status status={a.status} />
                        {/* a running run retries on its own */}
                        {a.status === 'failed' && runStatus !== 'running' && (
                          <Action
                            label="Run again"
                            path={`/attempts/${a.queueId}/again`}
                            onDone={openRun}
                          />
                        )}
                      </td>
                      <td>{a.device ?? '-'}</td>
                      <td>{duration(a.durationMs)}</td>
                      <td className="attempt-detail">
                        <p>
                          {a.status === 'pending'
                            ? 'Waiting for resources'
                            : a.progress
                              ? stageText(a.progress.stage)
                              : 'Progress unavailable'}
                        </p>
                        {originText(a)}
                        {a.progress && (
                          <details>
                            <summary>Phase and command history</summary>
                            <p className="muted">
                              Last update {time(a.progress.updatedAt)}. The last reported phase may
                              be stale after an interruption.
                            </p>
                            {a.progress.events.map((e) => (
                              <p key={e.id}>
                                {time(e.at)} · {stageText(e.stage)}
                              </p>
                            ))}
                            {a.progress.commands.length === 0 ? (
                              <p>No command timings available.</p>
                            ) : (
                              a.progress.commands.map((c) => (
                                <p key={c.id}>
                                  {time(c.startedAt)} · {c.command.replaceAll('_', ' ')} ·{' '}
                                  {c.status}
                                  {c.status !== 'running' && <> · {duration(c.durationMs)}</>}
                                </p>
                              ))
                            )}
                            <p className="muted">
                              Older entries omitted: {a.progress.droppedEvents} phases,{' '}
                              {a.progress.droppedCommands} commands.
                            </p>
                          </details>
                        )}
                        <p className="muted">
                          {a.inputsVerified ? 'Inputs verified' : 'Inputs unavailable'}
                        </p>
                        {a.inputRuntime && (
                          <details>
                            <summary>Runtime</summary>
                            <p>
                              Node {a.inputRuntime.node} · runner {a.inputRuntime.runner} ·
                              WebdriverIO {a.inputRuntime.webdriver}
                            </p>
                            <p>
                              Appium {a.inputRuntime.appium ?? 'unknown'};{' '}
                              {a.inputRuntime.automation ?? 'automation unknown'}; driver{' '}
                              {a.inputRuntime.driver ?? 'unknown'}; OS{' '}
                              {a.inputRuntime.platformVersion ?? 'unknown'}
                            </p>
                          </details>
                        )}
                      </td>
                      <td className="attempt-detail">
                        {a.recoveryAction === 'none' ? '-' : a.recoveryAction.replaceAll('_', ' ')}
                        {a.recoveryNote && <p>{a.recoveryNote}</p>}
                        {a.retryQueueId !== null && <p>Next attempt #{a.retryQueueId}</p>}
                      </td>
                      <td className="error-text attempt-detail">
                        {a.error && <ErrorText error={a.error} />}
                      </td>
                      <td className="files">
                        {a.fixtureCleanup !== 'none' && (
                          <p>
                            <a href={`#/fixtures?queueId=${a.queueId}`}>Fixtures</a>{' '}
                            <Status status={a.fixtureCleanup} />
                          </p>
                        )}
                        <a href={file(a, 'diagnostics')}>
                          Download diagnostics{!a.diagnostics && ' (available metadata)'}
                        </a>
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
            <p className="pager">
              {page > 0 && <a href={`#/runs/${runId}?page=${page - 1}`}>Previous attempts</a>}
              {next !== null && <a href={`#/runs/${runId}?page=${next}`}>Next attempts</a>}
            </p>
          </>
        )
      }
    </Loaded>
  )
}

export function RunPage({ id, page }: { id: number; page: number }) {
  const state = useApi(`/runs/${id}`, RunDetail, isRunning)
  // the attempts load next to the summary, not after it
  return (
    <>
      {/* the title shows while loading, like the other pages' */}
      <h1>
        Run #{id} {state.data && <Status status={state.data.status} />}
      </h1>
      <Loaded state={state}>
        {(run) => (
          <>
            <p className="actions">
              {isRunning(run) ? (
                <Action
                  label="Cancel run"
                  path={`/runs/${id}/cancel`}
                  ask={`Cancel run #${id}? Its open scenarios fail.`}
                />
              ) : (
                <>
                  <Action
                    label="Run again"
                    path={`/runs/${id}/again`}
                    body={{ failedOnly: false }}
                    onDone={openRun}
                  />
                  {run.scenarios.some((s) => s.status === 'failed') && (
                    <Action
                      label="Run failed again"
                      path={`/runs/${id}/again`}
                      body={{ failedOnly: true }}
                      onDone={openRun}
                    />
                  )}
                </>
              )}
            </p>
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
              <dt>Input manifest</dt>
              <dd>
                {!run.inputManifest.intent ? (
                  'Unavailable for this legacy run'
                ) : !run.inputManifest.resolved ? (
                  <>
                    <p>
                      {run.status === 'running'
                        ? 'Awaiting verified inputs'
                        : 'Inputs were not verified'}
                    </p>
                    {run.inputManifest.expected && (
                      <p>
                        Expected replay app SHA256:{' '}
                        <code>{run.inputManifest.expected.app.sha256}</code>
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p>
                      App SHA256: <code>{run.inputManifest.resolved.app.sha256}</code>
                    </p>
                    <p>
                      Scenario tree: <code>{run.inputManifest.resolved.scenarios.tree}</code>
                    </p>
                    <p>
                      Scenario folder:{' '}
                      <code>
                        {run.inputManifest.resolved.scenarios.directory ??
                          'unavailable for older evidence'}
                      </code>
                    </p>
                    <p>
                      Dependency lock:{' '}
                      <code>
                        {run.inputManifest.resolved.scenarios.lockSha256 ?? 'no lockfile'}
                      </code>
                    </p>
                    <p>
                      Ignored code SHA256:{' '}
                      <code>
                        {run.inputManifest.resolved.scenarios.ignoredCodeSha256 ??
                          'unavailable for older evidence'}
                      </code>
                    </p>
                    <p>
                      {run.inputManifest.resolved.config.sessionMode} sessions;{' '}
                      {run.inputManifest.resolved.config.scenarioTimeoutSeconds}s scenario limit
                    </p>
                  </>
                )}
                <p>
                  <a href={`/dashboard/api/runs/${id}/manifest?page=${page}`}>
                    Download inputs and attempt page {page + 1}
                  </a>
                </p>
              </dd>
              <dt>Trigger</dt>
              <dd>{run.trigger}</dd>
              <dt>Split</dt>
              <dd>{run.split}</dd>
              <dt>Release gate</dt>
              <dd>
                {run.release ? (
                  <>
                    <Status status={run.release.gate.status} /> {run.release.gate.policy} policy
                    <p>{releaseReasonText(run.release.gate.reason)}</p>
                    {run.release.source === 'legacy' && (
                      <p className="muted">Derived for a legacy run; no saved release decision.</p>
                    )}
                    {run.release.partialCoverage && (
                      <p>Subset rerun: cannot certify full release coverage.</p>
                    )}
                    {run.release.rerunOf && (
                      <p>
                        Rerun of{' '}
                        <a href={`#/runs/${run.release.rerunOf}`}>#{run.release.rerunOf}</a>.
                        Original history is preserved.
                      </p>
                    )}
                  </>
                ) : (
                  'Release gate unavailable; upgrade the server.'
                )}
              </dd>
              <dt>Retry policy</dt>
              <dd>
                {run.recovery ? (
                  <>
                    {run.recovery.maxAttempts} test attempts; up to{' '}
                    {run.recovery.maxInfrastructureRecoveries} infrastructure recoveries per
                    scenario, {run.recovery.infrastructureRecoveries}/
                    {run.recovery.maxRunInfrastructureRecoveries} used across this run.
                  </>
                ) : (
                  'Legacy total-attempt policy'
                )}
              </dd>
              <dt>App build</dt>
              <dd>{run.inputManifest.intent?.appSource ?? inputSource(run.appBuild)}</dd>
            </dl>

            {run.coverage.length > 0 && (
              <>
                <h2>Required coverage</h2>
                <div className="scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Profile</th>
                        <th>Results</th>
                        <th>Devices</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.coverage.map((c) => (
                        <tr key={c.profile.name}>
                          <td>
                            {c.profile.name}
                            <p className="muted">
                              {c.profile.deviceClass} {c.profile.platformVersion}
                            </p>
                          </td>
                          <td>
                            <Counts counts={c.counts} />
                          </td>
                          <td>
                            {c.availability === 'available'
                              ? 'Matching registration available'
                              : 'No enabled matching device'}
                            <p className="muted">Runtime is verified before execution.</p>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <h2>Phones</h2>
            <Timeline run={run} />
          </>
        )}
      </Loaded>
      <h2>Attempts</h2>
      <Attempts runId={id} page={page} platform={state.data?.platform} />
    </>
  )
}
