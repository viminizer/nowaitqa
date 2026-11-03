// Pieces every page uses, so the same thing looks the same everywhere.
import type { ReactNode } from 'react'
import type { ApiState } from './api.ts'

// Loading, error, and the data. A failed refresh keeps the last data and shows the error on top.
export function Loaded<T>({
  state,
  children,
}: {
  state: ApiState<T>
  children: (data: T) => ReactNode
}) {
  if (!state.data) {
    return state.error ? (
      <p className="error" role="alert">
        Could not load: {state.error}
      </p>
    ) : (
      <p className="muted">Loading…</p>
    )
  }
  return (
    <>
      {state.error && (
        <p className="error" role="alert">
          Could not refresh: {state.error}
        </p>
      )}
      {children(state.data)}
    </>
  )
}

// A run, scenario, attempt or phone status. A leased attempt is one a phone is running now.
export function Status({ status }: { status: string }) {
  return (
    <span className={`status status-${status}`}>{status === 'leased' ? 'running' : status}</span>
  )
}

// "passed 3 · flaky 1 · failed 0"; zeros are left out.
export function Counts({ counts }: { counts: Record<string, number> }) {
  const shown = Object.entries(counts).filter(([, n]) => n > 0)
  if (shown.length === 0) return <span className="muted">-</span>
  return (
    <span className="counts">
      {shown.map(([status, n]) => (
        <span key={status} className={`count status-${status}`}>
          {n} {status}
        </span>
      ))}
    </span>
  )
}

export function duration(ms: number | null) {
  if (ms === null) return '-'
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export const time = (date: Date | null) =>
  date ? date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' }) : '-'
