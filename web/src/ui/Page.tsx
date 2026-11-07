import type { ReactNode } from 'react'
export function Page({
  title,
  children,
  description,
  actions,
}: {
  title: ReactNode
  children: ReactNode
  description?: string
  actions?: ReactNode
}) {
  return (
    <section className="page" data-compact="true">
      <div className="page-heading">
        <div className="page-title">
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  )
}
