export function Summary({
  items,
  label = 'Current page summary',
}: {
  items: readonly { label: string; value: number }[]
  label?: string
}) {
  return (
    <dl className="summary" aria-label={label}>
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
