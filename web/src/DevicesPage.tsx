import { DeviceList } from '@nowait/shared'
import { useApi } from './api.ts'
import { Loaded, Status, time } from './ui.tsx'

export function DevicesPage() {
  const state = useApi('/devices', DeviceList)
  return (
    <>
      <h1>Phones</h1>
      <Loaded state={state}>
        {({ devices }) =>
          devices.length === 0 ? (
            <p className="muted">
              No phones yet. Add one with <code>PUT /devices</code>.
            </p>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Phone</th>
                    <th>Now</th>
                    <th>Last work</th>
                    <th>Platform</th>
                    <th>Machine</th>
                    <th>UDID</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((d) => (
                    <tr key={d.name}>
                      <td>{d.name}</td>
                      <td>
                        {!d.enabled ? (
                          <Status status="disabled" />
                        ) : d.busy ? (
                          <>
                            <Status status="busy" />{' '}
                            <a href={`#/runs/${d.busy.runId}`}>#{d.busy.runId}</a>{' '}
                            {d.busy.scenarioId}
                          </>
                        ) : (
                          <Status status="idle" />
                        )}
                      </td>
                      <td>{time(d.lastWorkAt)}</td>
                      <td>{d.platform}</td>
                      <td>{d.host}</td>
                      <td>
                        <code>{d.udid}</code>
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
