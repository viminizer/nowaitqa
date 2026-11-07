import {
  DbIdParam,
  SetupCreated,
  SetupHostsPage,
  SetupJob,
  SetupTargetsPage,
  setupReasonText,
} from '@nowait/shared'
import type { ReactNode } from 'react'
import { useApi } from '../../lib/api.ts'
import {
  Action,
  DataPanel,
  EmptyState,
  Link,
  Loaded,
  Status,
  Table,
  TableFooter,
  time,
} from '../../ui/index.ts'

const devicesUrl = (params: Record<string, string> = {}) =>
  `#/devices?${new URLSearchParams({ view: 'setup', ...params })}`
function SetupProgress({ id, toolbar }: { id: number; toolbar: ReactNode }) {
  const state = useApi(
    `/virtual/jobs/${id}`,
    SetupJob,
    (job) => job.status === 'queued' || job.status === 'active',
  )
  return (
    <DataPanel
      title={state.data ? `Setup #${id}: ${state.data.target.name}` : `Setup #${id}`}
      toolbar={toolbar}
      metadata={state.data && <Status status={state.data.status} />}
      description="A device started by setup may remain running after cancellation or failure."
    >
      <Loaded state={state}>
        {(job) => (
          <>
            <Table label="Device setup progress">
              <thead>
                <tr>
                  <th>Detail</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Device</th>
                  <td>
                    {job.target.name}
                    <p>
                      {job.target.platform} · {job.target.runtime}
                    </p>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Machine</th>
                  <td>
                    <Link variant="inline" href={devicesUrl({ host: job.host })}>
                      {job.host}
                    </Link>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Stage</th>
                  <td>
                    {job.stage}
                    {job.cancelRequested && <p>Cancellation requested</p>}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Status</th>
                  <td>
                    <Status status={job.status} />
                    {job.reason && <p>{setupReasonText(job.reason)}</p>}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Registration</th>
                  <td>
                    {job.deviceName ?? 'Not registered'}
                    {job.deviceName && (
                      <p>
                        <Link href="#/devices">View registered devices</Link>
                      </p>
                    )}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Started</th>
                  <td>{time(job.createdAt)}</td>
                </tr>
                {job.canResolve && (
                  <tr>
                    <th scope="row">Recovery</th>
                    <td>
                      Stop the previous setup runner and confirm its commands have ended before
                      releasing this reservation. Then restart the runner and refresh discovery.
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
            <TableFooter label={`Updated ${time(job.updatedAt)}`}>
              <Link href={devicesUrl({ host: job.host })}>Devices on this machine</Link>
              {job.canCancel && (
                <Action label="Cancel setup" path={`/virtual/jobs/${job.id}/cancel`} />
              )}
              {job.canResolve && (
                <Action
                  label="Confirm previous setup stopped"
                  path={`/virtual/jobs/${job.id}/resolve`}
                  body={{ confirmedStopped: true }}
                  ask="Have you stopped the previous setup runner and confirmed its setup commands have ended? The virtual device may remain running."
                />
              )}
            </TableFooter>
          </>
        )}
      </Loaded>
    </DataPanel>
  )
}
function Targets({
  host,
  after,
  toolbar,
}: {
  host: string
  after: string | null
  toolbar: ReactNode
}) {
  const query = new URLSearchParams({ host })
  if (after) query.set('after', after)
  const state = useApi(`/virtual/targets?${query}`, SetupTargetsPage)
  return (
    <DataPanel
      title={`Virtual devices on ${host}`}
      toolbar={toolbar}
      description="Choose an installed device by name. Discovery never starts devices; Appium and its driver must already be running."
      metadata={state.data && <Status status={state.data.host.online ? 'online' : 'offline'} />}
    >
      <Loaded state={state}>
        {(data) => (
          <>
            {!data.host.inventoryFresh && (
              <p>Waiting for fresh discovery. Keep the runner running on this machine.</p>
            )}
            {data.blocking && (
              <p>
                <Link href={devicesUrl({ host, setup: String(data.blocking.id) })}>
                  View current setup #{data.blocking.id}
                </Link>{' '}
                One setup runs on this machine at a time.
              </p>
            )}
            {data.host.issues.map((issue) => (
              <p key={issue}>{setupReasonText(issue)}</p>
            ))}
            {data.targets.length === 0 ? (
              <EmptyState
                title={after ? 'No more virtual devices' : 'No installed virtual devices'}
                description={
                  after
                    ? 'Return to the first device page to review this machine.'
                    : 'Install an Android AVD or an iOS Simulator runtime on this machine, then wait for discovery.'
                }
              />
            ) : (
              <Table label="Installed virtual devices">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Platform / runtime</th>
                    <th>State</th>
                    <th>Registration</th>
                    <th>Setup</th>
                  </tr>
                </thead>
                <tbody>
                  {data.targets.map(({ target, registered, conflict, job }) => {
                    const busy = job && ['queued', 'active', 'interrupted'].includes(job.status)
                    return (
                      <tr key={target.key}>
                        <td>{target.name}</td>
                        <td>
                          {target.platform === 'ios' ? 'iOS Simulator' : 'Android'}
                          <p>{target.runtime}</p>
                        </td>
                        <td>
                          <Status status={target.state} />
                          {target.issue && <p>{setupReasonText(target.issue)}</p>}
                        </td>
                        <td>
                          {conflict && (
                            <p>
                              Device identity conflicts with {conflict}. Stop affected devices and
                              review their manual registrations before retrying.
                            </p>
                          )}
                          {registered ? (
                            <>
                              {registered.name}
                              {!registered.enabled && (
                                <p>
                                  <Status status="disabled" />
                                </p>
                              )}
                            </>
                          ) : (
                            'Not registered'
                          )}
                        </td>
                        <td>
                          {busy ? (
                            <Link href={devicesUrl({ host, setup: String(job.id) })}>
                              View setup #{job.id}
                            </Link>
                          ) : !conflict &&
                            data.host.inventoryFresh &&
                            target.state !== 'unavailable' &&
                            !target.issue &&
                            (!registered || target.state !== 'running') ? (
                            <Action
                              label={target.state === 'stopped' ? 'Start and register' : 'Register'}
                              path="/virtual/jobs"
                              body={{ host, key: target.key, boot: target.state === 'stopped' }}
                              onDone={(answer) => {
                                location.hash = devicesUrl({
                                  host,
                                  setup: String(SetupCreated.parse(answer).id),
                                })
                              }}
                            />
                          ) : registered && target.state === 'running' ? (
                            'Registered'
                          ) : (
                            'Unavailable'
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </Table>
            )}
            <TableFooter
              label={`Discovery ${time(data.host.inventoryAt)} · ${data.targets.length} devices on this page`}
            >
              <Link href={devicesUrl()}>All machines</Link>
              {after && <Link href={devicesUrl({ host })}>First devices</Link>}
              {data.next && (
                <Link href={devicesUrl({ host, targetsAfter: data.next })}>More devices</Link>
              )}
            </TableFooter>
          </>
        )}
      </Loaded>
    </DataPanel>
  )
}
function Hosts({ after, toolbar }: { after: string | null; toolbar: ReactNode }) {
  const state = useApi(
    `/virtual/hosts${after ? `?after=${encodeURIComponent(after)}` : ''}`,
    SetupHostsPage,
  )
  return (
    <DataPanel
      title="Runner machines"
      toolbar={toolbar}
      description="Select a machine, then an installed virtual device. Discovery does not boot devices."
    >
      <Loaded state={state}>
        {(data) => (
          <>
            {data.hosts.length === 0 ? (
              <EmptyState
                title={after ? 'No more runner machines' : 'No runner machines yet'}
                description={
                  after
                    ? 'Return to the first machine page to continue setup.'
                    : 'Start a runner with SERVER_URL, RUNNER_TOKEN and a unique HOST. It can discover installed virtual devices before any are registered.'
                }
              />
            ) : (
              <Table label="Runner machines">
                <thead>
                  <tr>
                    <th>Machine</th>
                    <th>Runner contact</th>
                    <th>Discovery</th>
                    <th>Tools</th>
                    <th>Setup</th>
                  </tr>
                </thead>
                <tbody>
                  {data.hosts.map((machine) => (
                    <tr key={machine.name}>
                      <td>
                        {machine.name}
                        <p>{machine.os}</p>
                      </td>
                      <td>
                        <Status status={machine.online ? 'online' : 'offline'} />
                        <p>{time(machine.lastSeenAt)}</p>
                      </td>
                      <td>
                        {machine.inventoryFresh ? 'Fresh inventory' : 'Waiting for discovery'}
                        <p>{time(machine.inventoryAt)}</p>
                      </td>
                      <td>
                        {machine.issues.length
                          ? machine.issues.map((issue) => (
                              <p key={issue}>{setupReasonText(issue)}</p>
                            ))
                          : 'No discovery issues reported'}
                      </td>
                      <td>
                        <Link href={devicesUrl({ host: machine.name })}>
                          Choose a virtual device
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            <TableFooter label={`${data.hosts.length} machines on this page`}>
              {after && <Link href={devicesUrl()}>First machines</Link>}
              {data.next && <Link href={devicesUrl({ hostsAfter: data.next })}>More machines</Link>}
            </TableFooter>
          </>
        )}
      </Loaded>
    </DataPanel>
  )
}
export function VirtualDevices({
  params,
  toolbar,
}: {
  params: URLSearchParams
  toolbar: ReactNode
}) {
  if (params.has('setup')) {
    const setup = DbIdParam.safeParse(params.get('setup'))
    return setup.success ? (
      <SetupProgress key={setup.data} id={setup.data} toolbar={toolbar} />
    ) : (
      <DataPanel title="Device setup" toolbar={toolbar}>
        <EmptyState
          title="Invalid setup ID"
          description="Choose a runner machine to start or review a setup."
          action={<Link href={devicesUrl()}>All machines</Link>}
        />
      </DataPanel>
    )
  }
  const host = params.get('host')
  return host ? (
    <Targets key={host} host={host} after={params.get('targetsAfter')} toolbar={toolbar} />
  ) : (
    <Hosts after={params.get('hostsAfter')} toolbar={toolbar} />
  )
}
