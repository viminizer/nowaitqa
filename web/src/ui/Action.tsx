import { useAction } from '../lib/api.ts'
import { Button } from './Button.tsx'
// A button that changes something on the server. It asks first when `ask` is set, and shows the
// error next to it. onDone gets the answer (a new run's id, for "run again").
export function Action({
  label,
  path,
  body,
  ask,
  onDone,
}: {
  label: string
  path: string
  body?: object
  ask?: string
  onDone?: (answer: unknown) => void
}) {
  const action = useAction()
  const run = () => {
    if (ask && !confirm(ask)) return
    action.mutate({ path, body }, { onSuccess: onDone })
  }
  return (
    <span className="action">
      <Button type="button" disabled={action.isPending} onClick={run}>
        {label}
      </Button>
      <ActionError error={action.error} />
    </span>
  )
}

export function ActionError({ error }: { error: Error | null }) {
  return (
    error && (
      <span className="error" role="alert">
        {error.message}
      </span>
    )
  )
}
