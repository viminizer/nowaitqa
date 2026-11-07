import type { FormEvent } from 'react'
import { useAction } from '../../lib/api.ts'
import { Dialog } from '../../ui/Dialog.tsx'
import { Form } from '../../ui/Form.tsx'
import { Icon } from '../../ui/Icon.tsx'
import { ActionError, Button, Input, openRun } from '../../ui/index.ts'
import { Select } from '../../ui/Select.tsx'

export function StartRun({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const action = useAction()
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (action.isPending) return
    const fields = new FormData(event.currentTarget)
    action.mutate(
      {
        path: '/runs',
        body: {
          platform: fields.get('platform'),
          releasePolicy: fields.get('releasePolicy'),
          profiles: String(fields.get('versions') ?? '')
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean)
            .map((platformVersion) => ({
              name: `${fields.get('platform')}-${platformVersion}`,
              deviceClass: fields.get('platform') === 'ios' ? 'ios-simulator' : 'android-emulator',
              platformVersion,
            })),
          appBuild: String(fields.get('appBuild') ?? '').trim(),
        },
      },
      { onSuccess: openRun },
    )
  }
  return (
    <Dialog title="Start a new run" isOpen onOpenChange={onOpenChange} busy={action.isPending}>
      <Form layout="dialog" onSubmit={submit} aria-label="Start run" aria-busy={action.isPending}>
        <p className="muted">Choose your build. The runner handles the queue.</p>
        <fieldset disabled={action.isPending}>
          <label htmlFor="start-build">
            App build URL or path
            <Input
              id="start-build"
              name="appBuild"
              required
              pattern=".*\S.*"
              title="Enter an app build URL or path."
              autoComplete="off"
              placeholder="https://builds.example.com/app.apk"
              aria-describedby="start-build-help"
            />
            <span className="muted" id="start-build-help">
              Android APK or iOS Simulator .app / ZIP. Local paths are on the Appium machine.
            </span>
          </label>
          <div className="form-columns">
            <label htmlFor="start-platform">
              Platform
              <Select
                id="start-platform"
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
            Permissive accepts a later pass after retry. Strict rejects flaky scenarios.
          </p>
          <details>
            <summary>Required OS coverage</summary>
            <label htmlFor="start-versions">
              OS versions
              <Input
                id="start-versions"
                name="versions"
                placeholder="15, 16"
                aria-describedby="start-versions-help"
              />
              <span className="muted" id="start-versions-help">
                Every scenario runs on each listed version. Leave blank to use the shared queue.
                Uses the latest scenarios available from a runner.
              </span>
            </label>
          </details>
        </fieldset>
        <ActionError error={action.error} />
        <div className="dialog-actions">
          <span className="muted">Runs execute on registered devices.</span>
          <Button disabled={action.isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={action.isPending}>
            {action.isPending ? 'Starting…' : 'Start run'}
            <Icon name="arrow" />
          </Button>
        </div>
      </Form>
    </Dialog>
  )
}
