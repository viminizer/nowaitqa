import { Link } from './Link.tsx'
export function FilterTabs({
  items,
  label = 'Filter runs by status',
}: {
  label?: string
  items: readonly { label: string; href: string; active: boolean }[]
}) {
  return (
    <nav className="filter-tabs" aria-label={label}>
      {items.map((item) => (
        <Link key={item.label} href={item.href} aria-current={item.active ? 'true' : undefined}>
          {item.label}
        </Link>
      ))}
    </nav>
  )
}
