import type { UseQueryResult } from '@tanstack/react-query'
import type { ReactNode } from 'react'
export function Loading() {
  return <p className="muted">Loading…</p>
}

// Loading, error, and the data. A failed refresh keeps the last data and shows the error on top.
export function Loaded<T>({
  state,
  children,
}: {
  state: UseQueryResult<T>
  children: (data: T) => ReactNode
}) {
  if (!state.data) {
    return state.error ? (
      <p className="error" role="alert">
        Could not load: {state.error.message}
      </p>
    ) : (
      <Loading />
    )
  }
  return (
    <>
      {state.error && (
        <p className="error" role="alert">
          Could not refresh: {state.error.message}
        </p>
      )}
      {children(state.data)}
    </>
  )
}
