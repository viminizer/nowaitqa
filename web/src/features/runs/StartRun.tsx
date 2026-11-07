import type { Platform } from '@nowait/shared'
import { type FormEvent, useRef, useState } from 'react'
import { useAction } from '../../lib/api.ts'
import { Dialog } from '../../ui/Dialog.tsx'
import { Form } from '../../ui/Form.tsx'
import { Icon } from '../../ui/Icon.tsx'
import { ActionError, Button, Input, Link, openLaunch, openRun } from '../../ui/index.ts'
import { Select } from '../../ui/Select.tsx'

// getRandomValues also works on HTTP LAN previews, where randomUUID is unavailable.
function requestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = ((bytes[6] ?? 0) & 15) | 64
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function StartRun({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const action = useAction()
  const [selection, setSelection] = useState('android')
  const [builds, setBuilds] = useState({ android: '', ios: '' })
  const [versions, setVersions] = useState({ android: '', ios: '' })
  const [launchId, setLaunchId] = useState<string | null>(null)
  const request = useRef<{ payload: string; id: string } | null>(null)
  const platforms: Platform[] =
    selection === 'both' ? ['android', 'ios'] : [selection === 'ios' ? 'ios' : 'android']
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (action.isPending) return
    const fields = new FormData(event.currentTarget)
    const targets = platforms.map((platform) => ({
      platform,
      appBuild: builds[platform].trim(),
      releasePolicy: fields.get('releasePolicy'),
      profiles: versions[platform]
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .map((platformVersion) => ({
          name: `${platform}-${platformVersion}`,
          deviceClass: platform === 'ios' ? 'ios-simulator' : 'android-emulator',
          platformVersion,
        })),
    }))
    if (selection === 'both') {
      const payload = JSON.stringify(targets)
      if (request.current?.payload !== payload) request.current = { payload, id: requestId() }
      setLaunchId(request.current.id)
      action.mutate(
        { path: '/launches', body: { id: request.current.id, targets } },
        { onSuccess: openLaunch },
      )
    } else {
      setLaunchId(null)
      action.mutate({ path: '/runs', body: targets[0] }, { onSuccess: openRun })
    }
  }
  return (
    <Dialog title="Start a new run" isOpen onOpenChange={onOpenChange} busy={action.isPending}>
      <Form layout="dialog" onSubmit={submit} aria-label="Start run" aria-busy={action.isPending}>
        <p className="muted">
          Choose one platform or launch Android and iOS together. Each platform uses its own build
          and results.
        </p>
        <fieldset disabled={action.isPending}>
          <div className="form-columns">
            <label htmlFor="start-platform">
              Platform
              <Select
                id="start-platform"
                name="platform"
                value={selection}
                onValueChange={setSelection}
                label="Platform"
                options={[
                  { value: 'android', label: 'Android' },
                  { value: 'ios', label: 'iOS Simulator' },
                  { value: 'both', label: 'Android + iOS Simulator' },
                ]}
                disabled={action.isPending}
              />
            </label>
            <label htmlFor="start-release-policy">
              Release policy
              <Select
                id="start-release-policy"
                name="releasePolicy"
                defaultValue="permissive"
                label="Release policy"
                options={[
                  { value: 'permissive', label: 'Permissive' },
                  { value: 'strict', label: 'Strict' },
                ]}
                disabled={action.isPending}
                aria-describedby="start-policy-help"
              />
            </label>
          </div>
          <p className="muted" id="start-policy-help">
            Permissive accepts a later pass after retry. Strict rejects flaky scenarios. The policy
            applies to every selected platform.
          </p>
          {platforms.map((platform) => (
            <div key={platform}>
              <label htmlFor={`start-build-${platform}`}>
                {platform === 'ios'
                  ? 'iOS Simulator build URL or path'
                  : 'Android build URL or path'}
                <Input
                  id={`start-build-${platform}`}
                  name={`build-${platform}`}
                  required
                  pattern=".*\S.*"
                  title="Enter an app build URL or path."
                  autoComplete="off"
                  placeholder={
                    platform === 'ios'
                      ? 'https://builds.example.com/app.app.zip'
                      : 'https://builds.example.com/app.apk'
                  }
                  value={builds[platform]}
                  onChange={(event) => setBuilds({ ...builds, [platform]: event.target.value })}
                  aria-describedby={`start-build-help-${platform}`}
                />
                <span className="muted" id={`start-build-help-${platform}`}>
                  {platform === 'ios' ? 'iOS Simulator .app or ZIP.' : 'Android APK.'} Local paths
                  are on the Appium machine.
                </span>
              </label>
              <details>
                <summary>Required {platform === 'ios' ? 'iOS' : 'Android'} OS coverage</summary>
                <label htmlFor={`start-versions-${platform}`}>
                  OS versions
                  <Input
                    id={`start-versions-${platform}`}
                    name={`versions-${platform}`}
                    placeholder={platform === 'ios' ? '18.5, 19' : '15, 16'}
                    value={versions[platform]}
                    onChange={(event) =>
                      setVersions({ ...versions, [platform]: event.target.value })
                    }
                    aria-describedby={`start-versions-help-${platform}`}
                  />
                  <span className="muted" id={`start-versions-help-${platform}`}>
                    Every scenario runs on each listed version. Leave blank to use the shared queue.
                  </span>
                </label>
              </details>
            </div>
          ))}
          {selection === 'both' && (
            <p className="muted">
              Both runs use the same scenario revision. They start together; execution depends on
              available devices for each platform.
            </p>
          )}
        </fieldset>
        <ActionError error={action.error} />
        {action.error && launchId && (
          <p>
            <Link href={`#/launches/${launchId}`}>Check submitted launch</Link>
          </p>
        )}
        <div className="dialog-actions">
          <span className="muted">Runs execute on registered devices.</span>
          <Button disabled={action.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={action.isPending}>
            {action.isPending
              ? 'Starting…'
              : selection === 'both'
                ? 'Start both platforms'
                : 'Start run'}
            <Icon name="arrow" />
          </Button>
        </div>
      </Form>
    </Dialog>
  )
}
