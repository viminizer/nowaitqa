const statusStyle: Record<string, string> = {
  cleaned: 'passed',
  quarantined: 'failed',
  cleaning: 'leased',
  accepted: 'passed',
  rejected: 'failed',
}

// A run, scenario, attempt or phone status. A leased attempt is one a phone is running now.
export function Status({ status }: { status: string }) {
  return (
    <span className={`status status-${statusStyle[status] ?? status}`} data-appearance="soft">
      {status === 'leased' ? 'running' : status === 'waiting' ? 'waiting for runner' : status}
    </span>
  )
}

// "passed 3 · flaky 1 · failed 0"; zeros are left out.
export function Counts({
  counts,
  appearance = 'default',
}: {
  counts: Record<string, number>
  appearance?: 'default' | 'progress'
}) {
  const shown = Object.entries(counts).filter(([, n]) => n > 0)
  if (shown.length === 0) return <span className="muted">-</span>
  if (appearance === 'progress') {
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
    const passed = (counts.passed ?? 0) + (counts.flaky ?? 0)
    return (
      <span className="scenario-results">
        <span>
          {passed}
          <span className="muted"> / {total}</span>
        </span>
        <progress
          className="scenario-progress"
          max={total}
          value={passed}
          aria-label="Passed scenarios including later-pass recovery"
        />
      </span>
    )
  }
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
