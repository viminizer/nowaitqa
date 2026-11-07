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
import { useApi } from '../../lib/api.ts'
import { FilterTabs } from '../../ui/FilterTabs.tsx'
import {
  Action,
  Counts,
  DataPanel,
  duration,
  EmptyState,
  Loaded,
  openRun,
  Page,
  Status,
  Summary,
  Table,
  TableFooter,
  time,
} from '../../ui/index.ts'
import { Link } from '../../ui/Link.tsx'
import { Timeline } from './Timeline.tsx'

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
          <EmptyState
            title={page > 0 ? 'No more attempts' : 'No attempts yet'}
            description={
              page > 0
                ? 'Return to the first attempt page to review this run.'
                : 'Attempts will appear when scenarios enter the queue.'
            }
            action={page > 0 && <Link href={`#/runs/${runId}?view=attempts`}>First page</Link>}
          />
        ) : (
          <>
            <Table>
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
                        <Link
                          variant="inline"
                          href={`#/history?scenarioId=${encodeURIComponent(a.scenarioId)}&platform=${platform}`}
                        >
                          {a.scenarioId}
                        </Link>
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
                            Last update {time(a.progress.updatedAt)}. The last reported phase may be
                            stale after an interruption.
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
                                {time(c.startedAt)} · {c.command.replaceAll('_', ' ')} · {c.status}
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
                          <Link href={`#/fixtures?queueId=${a.queueId}`}>Fixtures</Link>{' '}
                          <Status status={a.fixtureCleanup} />
                        </p>
                      )}
                      <Link href={file(a, 'diagnostics')}>
                        Download diagnostics{!a.diagnostics && ' (available metadata)'}
                      </Link>
                      {a.screenshot && (
                        <Link href={file(a, 'screenshot')} target="_blank" rel="noreferrer">
                          <img
                            src={file(a, 'screenshot')}
                            alt={`Screenshot of ${a.scenarioId}`}
                            loading="lazy"
                          />
                        </Link>
                      )}
                      {a.log && (
                        <Link href={file(a, 'log')} target="_blank" rel="noreferrer">
                          Log
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <TableFooter label={`Attempt page ${page + 1}`}>
              {page > 0 && (
                <Link href={`#/runs/${runId}?view=attempts&page=${page - 1}`}>
                  Previous attempts
                </Link>
              )}
              {next !== null && (
                <Link href={`#/runs/${runId}?view=attempts&page=${next}`}>Next attempts</Link>
              )}
              <Link href={`/dashboard/api/runs/${runId}/manifest?page=${page}`}>
                Download inputs and attempt page {page + 1}
              </Link>
            </TableFooter>
          </>
        )
      }
    </Loaded>
  )
}

function RunActions({ run }: { run: RunDetail }) {
  const id = run.id
  return (
    <div className="actions">
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
    </div>
  )
}

export function RunPage({
  id,
  page,
  view = 'overview',
}: {
  id: number
  page: number
  view?: string
}) {
  const state = useApi(`/runs/${id}`, RunDetail, isRunning)
  const selected = ['attempts', 'coverage', 'timeline'].includes(view) ? view : 'overview'
  return (
    <Page
      title={
        <>
          Run #{id} {state.data && <Status status={state.data.status} />}
        </>
      }
      description="Inputs, execution and saved evidence."
      actions={state.data && <RunActions run={state.data} />}
    >
      {state.data && (
        <Summary
          label="Scenario outcome summary"
          items={['passed', 'flaky', 'failed', 'pending'].map((status) => ({
            label:
              status === 'passed'
                ? 'Passed'
                : status === 'flaky'
                  ? 'Flaky'
                  : status === 'failed'
                    ? 'Failed'
                    : 'Pending',
            value: state.data.scenarios.filter((s) => s.status === status).length,
          }))}
        />
      )}
      <DataPanel
        title={
          selected === 'attempts'
            ? 'Scenario attempts'
            : selected === 'coverage'
              ? 'Required coverage'
              : selected === 'timeline'
                ? 'Execution timeline'
                : 'Run overview'
        }
        toolbar={
          <FilterTabs
            label="Run detail views"
            items={[
              { label: 'Overview', href: `#/runs/${id}`, active: selected === 'overview' },
              {
                label: 'Attempts',
                href: `#/runs/${id}?view=attempts`,
                active: selected === 'attempts',
              },
              {
                label: 'Coverage',
                href: `#/runs/${id}?view=coverage`,
                active: selected === 'coverage',
              },
              {
                label: 'Timeline',
                href: `#/runs/${id}?view=timeline`,
                active: selected === 'timeline',
              },
            ]}
          />
        }
        metadata={
          state.data?.release && (
            <>
              Release gate <Status status={state.data.release.gate.status} />
              <span>
                {state.data.release.gate.policy}
                {state.data.release.source === 'legacy' ? ' · derived' : ' · saved'}
              </span>
            </>
          )
        }
      >
        {selected === 'attempts' ? (
          <>
            <Loaded state={state}>{() => null}</Loaded>
            <Attempts runId={id} page={page} platform={state.data?.platform} />
          </>
        ) : (
          <Loaded state={state}>
            {(run) =>
              selected === 'coverage' ? (
                run.coverage.length === 0 ? (
                  <EmptyState
                    title="No required coverage profiles"
                    description="This run uses the shared device queue without required coverage profiles."
                  />
                ) : (
                  <Table label="Required coverage">
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
                  </Table>
                )
              ) : selected === 'timeline' ? (
                <Timeline run={run} />
              ) : (
                <Table label="Run overview">
                  <thead>
                    <tr>
                      <th>Detail</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row">Scenarios</th>
                      <td>
                        <Counts counts={countStatuses(run.scenarios.map((s) => s.status))} />
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">Started</th>
                      <td>{time(run.createdAt)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Duration</th>
                      <td>{duration(run.durationMs)}</td>
                    </tr>
                    <tr>
                      <th scope="row">Platform</th>
                      <td>{run.platform}</td>
                    </tr>
                    <tr>
                      <th scope="row">Commit</th>
                      <td>
                        <code>{run.commit}</code>
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">Input manifest</th>
                      <td>
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
                              Scenario tree:{' '}
                              <code>{run.inputManifest.resolved.scenarios.tree}</code>
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
                              {run.inputManifest.resolved.config.scenarioTimeoutSeconds}s scenario
                              limit
                            </p>
                          </>
                        )}
                        <p>
                          <Link href={`/dashboard/api/runs/${id}/manifest?page=${page}`}>
                            Download inputs and attempt page {page + 1}
                          </Link>
                        </p>
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">Trigger</th>
                      <td>{run.trigger}</td>
                    </tr>
                    <tr>
                      <th scope="row">Split</th>
                      <td>{run.split}</td>
                    </tr>
                    <tr>
                      <th scope="row">Release gate</th>
                      <td>
                        {run.release ? (
                          <>
                            <Status status={run.release.gate.status} /> {run.release.gate.policy}{' '}
                            policy
                            <p>{releaseReasonText(run.release.gate.reason)}</p>
                            {run.release.source === 'legacy' && (
                              <p className="muted">
                                Derived for a legacy run; no saved release decision.
                              </p>
                            )}
                            {run.release.partialCoverage && (
                              <p>Subset rerun: cannot certify full release coverage.</p>
                            )}
                            {run.release.rerunOf && (
                              <p>
                                Rerun of{' '}
                                <Link variant="inline" href={`#/runs/${run.release.rerunOf}`}>
                                  #{run.release.rerunOf}
                                </Link>
                                . Original history is preserved.
                              </p>
                            )}
                          </>
                        ) : (
                          'Release gate unavailable; upgrade the server.'
                        )}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">Retry policy</th>
                      <td>
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
                      </td>
                    </tr>
                    <tr>
                      <th scope="row">App build</th>
                      <td>{run.inputManifest.intent?.appSource ?? inputSource(run.appBuild)}</td>
                    </tr>
                  </tbody>
                </Table>
              )
            }
          </Loaded>
        )}
      </DataPanel>
    </Page>
  )
}
