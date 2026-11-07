import type { ReactNode } from 'react'
// A named, focusable scroll region lets keyboard users reach overflowing rows.
export function Table({ children, label = 'Data table' }: { children: ReactNode; label?: string }) {
  return (
    <section className="scroll" aria-label={label} tabIndex={0}>
      <table>{children}</table>
    </section>
  )
}
