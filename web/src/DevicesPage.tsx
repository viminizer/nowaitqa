import { DeviceList } from '@nowait/shared'
import type { FormEvent } from 'react'
import { useAction, useApi } from './api.ts'
import { Action, ActionError, Loaded, Status, time } from './ui.tsx'

function AddDevice() {
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
      { onSuccess: () => form.reset() },
    )
  }
  return (
    <form
      className="action-form device-form"
      onSubmit={submit}
      aria-labelledby="add-device-title"
      aria-describedby="add-device-help"
      aria-busy={action.isPending}
    >
      <h2 id="add-device-title">Add device</h2>
      <p className="muted" id="add-device-help">
        Register an Android device or iOS Simulator. Start Appium and the runner on its machine; the
        runner picks up new devices within a minute. Existing registrations stay unchanged.
      </p>
      <fieldset disabled={action.isPending}>
        <label htmlFor="device-name">
          Name
          <input id="device-name" name="name" required pattern=".*\S.*" autoComplete="off" />
        </label>
        <label htmlFor="device-platform">
          Platform
          <select id="device-platform" name="platform" defaultValue="android">
            <option value="android">Android</option>
            <option value="ios">iOS Simulator</option>
          </select>
        </label>
        <label htmlFor="device-udid">
          UDID
          <input
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
          <input
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
          <input
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
          <input
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
          <input
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
          <button type="submit">{action.isPending ? 'Adding…' : 'Add device'}</button>
        </span>
      </fieldset>
      <ActionError error={action.error} />
      {action.isSuccess && (
        <p role="status">Device added. The runner picks it up within a minute.</p>
      )}
    </form>
  )
}

export function DevicesPage() {
  const state = useApi('/devices', DeviceList)
  return (
    <>
      <h1>Phones</h1>
      <AddDevice />
      <h2>Registered devices</h2>
      <p className="muted">
        Runner status shows recent contact, not whether Appium or the device is ready.
      </p>
      <Loaded state={state}>
        {({ devices }) =>
          devices.length === 0 ? (
            <p className="muted">No devices yet. Add one above.</p>
          ) : (
            <div className="scroll">
              <table>
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
                              <a href={`#/runs/${d.cleanup.runId}`}>#{d.cleanup.runId}</a>, attempt{' '}
                              {d.cleanup.queueId}.
                            </p>
                            {d.cleanup.fixtureState ? (
                              <p>
                                <a href={`#/fixtures?queueId=${d.cleanup.queueId}`}>
                                  Review fixture cleanup and recovery
                                </a>
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
                            <a href={`#/runs/${d.busy.runId}`}>#{d.busy.runId}</a>{' '}
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
              </table>
            </div>
          )
        }
      </Loaded>
    </>
  )
}
