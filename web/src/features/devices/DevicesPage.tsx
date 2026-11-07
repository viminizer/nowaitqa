import { DeviceList } from '@nowait/shared'
import { type FormEvent, useState } from 'react'
import { useAction, useApi } from '../../lib/api.ts'
import { Dialog } from '../../ui/Dialog.tsx'
import { FilterTabs } from '../../ui/FilterTabs.tsx'
import { Form } from '../../ui/Form.tsx'
import {
  Action,
  ActionError,
  Button,
  DataPanel,
  EmptyState,
  Input,
  Loaded,
  Page,
  Status,
  Summary,
  Table,
  time,
} from '../../ui/index.ts'
import { Link } from '../../ui/Link.tsx'
import { Select } from '../../ui/Select.tsx'
import { VirtualDevices } from './VirtualDevices.tsx'

function AddDevice({
  onOpenChange,
  onRegistered,
}: {
  onOpenChange: (open: boolean) => void
  onRegistered: () => void
}) {
  const action = useAction()
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (action.isPending) return
    const form = event.currentTarget
    const fields = new FormData(form)
    const value = (name: string) => String(fields.get(name) ?? '').trim()
    action.mutate(
      {
        path: '/devices',
        body: {
          name: value('name'),
          platform: value('platform'),
          udid: value('udid'),
          appiumUrl: value('appiumUrl'),
          host: value('host'),
          systemPort: Number(value('systemPort')),
          platformVersion: value('platformVersion') || null,
        },
      },
      {
        onSuccess: () => {
          form.reset()
          onRegistered()
        },
      },
    )
  }
  return (
    <Dialog title="Add device" isOpen onOpenChange={onOpenChange} busy={action.isPending}>
      <Form
        layout="two-column"
        onSubmit={submit}
        aria-label="Add device"
        aria-describedby="add-device-help"
        aria-busy={action.isPending}
      >
        <p className="muted" id="add-device-help">
          Register an Android device or iOS Simulator. Start Appium and the runner on its machine;
          the runner picks up new devices within a minute. Existing registrations stay unchanged.
        </p>
        <fieldset disabled={action.isPending}>
          <label htmlFor="device-name">
            Name
            <Input id="device-name" name="name" required pattern=".*\S.*" autoComplete="off" />
          </label>
          <label htmlFor="device-platform">
            Platform
            <Select
              id="device-platform"
              name="platform"
              defaultValue="android"
              label="Platform"
              options={[
                { value: 'android', label: 'Android' },
                { value: 'ios', label: 'iOS Simulator' },
              ]}
              disabled={action.isPending}
            />
          </label>
          <label htmlFor="device-udid">
            UDID
            <Input
              id="device-udid"
              name="udid"
              required
              pattern=".*\S.*"
              autoComplete="off"
              aria-describedby="device-udid-help"
            />
            <span className="muted" id="device-udid-help">
              Android serial from adb devices, or Simulator UUID from xcrun simctl list devices.
            </span>
          </label>
          <label htmlFor="device-version">
            OS version for required coverage (optional)
            <Input
              id="device-version"
              name="platformVersion"
              placeholder="16 or 18.5"
              aria-describedby="device-version-help"
            />
            <span className="muted" id="device-version-help">
              Use the exact version reported by Appium. Required profiles verify it again before
              execution.
            </span>
          </label>
          <label htmlFor="device-host">
            Machine
            <Input
              id="device-host"
              name="host"
              required
              pattern=".*\S.*"
              autoComplete="off"
              aria-describedby="device-host-help"
            />
            <span className="muted" id="device-host-help">
              Must match the runner's HOST setting.
            </span>
          </label>
          <label htmlFor="device-appium">
            Appium URL
            <Input
              id="device-appium"
              name="appiumUrl"
              type="url"
              required
              placeholder="http://127.0.0.1:4723"
              aria-describedby="device-appium-help"
            />
            <span className="muted" id="device-appium-help">
              Reachable from the runner's machine.
            </span>
          </label>
          <label htmlFor="device-port">
            System / WDA port
            <Input
              id="device-port"
              name="systemPort"
              type="number"
              min="1"
              max="65535"
              step="1"
              required
              aria-describedby="device-port-help"
            />
            <span className="muted" id="device-port-help">
              Use separate ports per device. iOS also reserves the next port for MJPEG.
            </span>
          </label>
          <span className="action">
            <Button type="submit" variant="primary">
              {action.isPending ? 'Adding…' : 'Add device'}
            </Button>
          </span>
        </fieldset>
        <ActionError error={action.error} />
        <Button onClick={() => onOpenChange(false)} disabled={action.isPending}>
          Cancel
        </Button>
      </Form>
    </Dialog>
  )
}

export function DevicesPage({ params }: { params: URLSearchParams }) {
  const virtual =
    params.get('view') === 'setup' ||
    params.has('host') ||
    params.has('setup') ||
    params.has('hostsAfter')
  const tabs = (
    <FilterTabs
      label="Phone views"
      items={[
        { label: 'Registered devices', href: '#/devices', active: !virtual },
        { label: 'Virtual device setup', href: '#/devices?view=setup', active: virtual },
      ]}
    />
  )

  const [adding, setAdding] = useState(false)
  const [registered, setRegistered] = useState(false)
  const state = useApi('/devices', DeviceList)
  return (
    <Page
      title="Phones"
      description="Your registered devices and runner activity."
      actions={
        <div className="actions">
          {!virtual && (
            <Link variant="primary" href="#/devices?view=setup">
              Set up virtual device
            </Link>
          )}
          <Button
            onClick={() => {
              setRegistered(false)
              setAdding(true)
            }}
          >
            Add device
          </Button>
        </div>
      }
    >
      {adding && (
        <AddDevice
          onOpenChange={setAdding}
          onRegistered={() => {
            setAdding(false)
            setRegistered(true)
          }}
        />
      )}
      {registered && <p role="status">Device added. The runner picks it up within a minute.</p>}
      {!virtual && state.data && (
        <Summary
          label="Registered device summary"
          items={[
            {
              label: 'Online runners',
              value: state.data.devices.filter((d) => d.connectivity === 'online').length,
            },
            {
              label: 'Busy devices',
              value: state.data.devices.filter((d) => d.busy !== null).length,
            },
            {
              label: 'Cleanup held',
              value: state.data.devices.filter((d) => d.cleanup !== null).length,
            },
            { label: 'Disabled', value: state.data.devices.filter((d) => !d.enabled).length },
          ]}
        />
      )}
      {virtual ? (
        <VirtualDevices params={params} toolbar={tabs} />
      ) : (
        <DataPanel
          toolbar={tabs}
          title="Registered devices"
          description="Runner status shows recent contact, not whether Appium or the device is ready."
          metadata={state.data && `${state.data.devices.length} devices`}
        >
          <Loaded state={state}>
            {({ devices }) =>
              devices.length === 0 ? (
                <EmptyState
                  title="No devices registered"
                  description="Add an Android device or iOS Simulator to your workspace."
                  action={
                    <Button
                      onClick={() => {
                        setRegistered(false)
                        setAdding(true)
                      }}
                    >
                      Add a device
                    </Button>
                  }
                />
              ) : (
                <Table>
                  <thead>
                    <tr>
                      <th>Phone</th>
                      <th>Runner</th>
                      <th>Last seen</th>
                      <th>Now</th>
                      <th>Last work</th>
                      <th>Platform</th>
                      <th>Machine</th>
                      <th>UDID</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((d) => (
                      <tr key={d.name}>
                        <td>{d.name}</td>
                        <td>
                          <Status status={d.connectivity} />
                        </td>
                        <td>{time(d.lastSeenAt)}</td>
                        <td className="device-state">
                          {d.cleanup ? (
                            <>
                              <Status status={d.cleanup.fixtureState ?? 'failed'} />
                              <p>
                                {d.cleanup.fixtureState === 'cleaning'
                                  ? 'Fixture cleanup in progress for '
                                  : 'Cleanup required for '}
                                <Link variant="inline" href={`#/runs/${d.cleanup.runId}`}>
                                  #{d.cleanup.runId}
                                </Link>
                                , attempt {d.cleanup.queueId}.
                              </p>
                              {d.cleanup.fixtureState ? (
                                <p>
                                  <Link href={`#/fixtures?queueId=${d.cleanup.queueId}`}>
                                    Review fixture cleanup and recovery
                                  </Link>
                                </p>
                              ) : (
                                <p>
                                  Verify the stopped runner and Appium session before releasing this
                                  device.
                                </p>
                              )}
                            </>
                          ) : !d.enabled ? (
                            <Status status="disabled" />
                          ) : d.pausedUntil ? (
                            <>
                              <Status status="paused" />
                              <p>{d.pauseReason}</p>
                              <p className="muted">Resumes {time(d.pausedUntil)}</p>
                            </>
                          ) : !d.busy ? (
                            d.connectivity === 'online' ? (
                              <Status status="idle" />
                            ) : (
                              <span className="muted">-</span>
                            )
                          ) : null}
                          {d.enabled && d.busy && (
                            <>
                              <Status status="busy" />{' '}
                              <Link variant="inline" href={`#/runs/${d.busy.runId}`}>
                                #{d.busy.runId}
                              </Link>{' '}
                              {d.busy.scenarioId}
                            </>
                          )}
                        </td>
                        <td>{time(d.lastWorkAt)}</td>
                        <td>
                          {d.platform}
                          <p className="muted">{d.platformVersion ?? 'OS version not set'}</p>
                        </td>
                        <td>{d.host}</td>
                        <td>
                          <code>{d.udid}</code>
                        </td>
                        <td>
                          {/* off: it finishes its current scenario, then takes no more */}
                          <Action
                            label={d.enabled ? 'Turn off' : 'Turn on'}
                            path={`/devices/${encodeURIComponent(d.name)}/enabled`}
                            body={{ enabled: !d.enabled }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )
            }
          </Loaded>
        </DataPanel>
      )}
    </Page>
  )
}
