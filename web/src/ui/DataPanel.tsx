import { type ReactNode, useId } from 'react'
export function DataPanel({
  title,
  description,
  metadata,
  toolbar,
  children,
}: {
  title: string
  description?: string
  metadata?: ReactNode
  toolbar?: ReactNode
  children: ReactNode
}) {
  const heading = useId()
  return (
    <section className="panel" aria-labelledby={heading}>
      <div className="panel-heading">
        <div>
          <h2 id={heading}>{title}</h2>
          {description && <p className="panel-description">{description}</p>}
        </div>
        {metadata && <div className="panel-meta">{metadata}</div>}
      </div>
      {toolbar && <div className="toolbar">{toolbar}</div>}
      {children}
    </section>
  )
}
