import type { ReactNode } from 'react'
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="scroll">
      <table>{children}</table>
    </div>
  )
}
