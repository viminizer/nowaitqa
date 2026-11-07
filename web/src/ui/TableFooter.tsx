import type { ReactNode } from 'react'
export function TableFooter({ label, children }: { label: ReactNode; children?: ReactNode }) {
  return (
    <div className="table-footer">
      <span>{label}</span>
      {children && <div>{children}</div>}
    </div>
  )
}
