import { messageOf } from '@nowait/shared'
import type { UseQueryResult } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { Button } from './Button.tsx'
import { Dialog } from './Dialog.tsx'

export function Loading() {
  return <p className="muted">Loading…</p>
}

// Keep long dependency/validation messages accessible without pushing a desktop page offscreen.
export function ErrorNotice({
  label,
  error,
  onRetry,
  retryLabel = 'Try again',
}: {
  label: string
  error: Error
  onRetry: () => void
  retryLabel?: string
}) {
  const [details, setDetails] = useState(false)
  const message = messageOf(error)
  return (
    <div className="error-notice">
      <span className="error" role="alert">
        {label}: {message.length <= 160 ? message : 'Open error details for the full message.'}
      </span>
      <Button onClick={() => setDetails(true)}>Error details</Button>
      <Button onClick={onRetry}>{retryLabel}</Button>
      {details && (
        <Dialog title="Error details" isOpen onOpenChange={setDetails}>
          <pre className="error-text">{message}</pre>
        </Dialog>
      )}
    </div>
  )
}

// A failed refresh keeps the last data and displays the recoverable error above it.
export function Loaded<T>({
  state,
  children,
}: {
  state: UseQueryResult<T>
  children: (data: T) => ReactNode
}) {
  if (!state.data)
    return state.error ? (
      <ErrorNotice
        label="Could not load"
        error={state.error}
        onRetry={() => void state.refetch()}
      />
    ) : (
      <Loading />
    )
  return (
    <>
      {state.error && (
        <ErrorNotice
          label="Could not refresh"
          error={state.error}
          onRetry={() => void state.refetch()}
        />
      )}
      {children(state.data)}
    </>
  )
}
