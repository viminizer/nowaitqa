import type { ReactNode } from 'react'
export function Page({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="page">
      <h1>{title}</h1>
      {children}
    </section>
  )
}
