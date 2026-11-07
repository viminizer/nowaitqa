// Only percentage geometry may use inline styles. All appearance stays in the stylesheet.
export function TimelineBlock({
  left,
  width,
  status,
  label,
}: {
  left: number
  width: number
  status: string
  label: string
}) {
  return (
    <div
      className={`block status-${status}`}
      style={{ left: `${left}%`, width: `${width}%` }}
      title={label}
      role="img"
      aria-label={label}
    />
  )
}
