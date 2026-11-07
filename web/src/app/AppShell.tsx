import type { ReactNode } from 'react'
export function AppShell({ path, children }: { path: string; children: ReactNode }) {
  return (
    <>
      <header>
        <a className="brand" href="#/">
          nowait-qa
        </a>
        <nav>
          <a
            href="#/"
            aria-current={
              path === '/' || path === '' || path.startsWith('/runs/') ? 'page' : undefined
            }
          >
            Runs
          </a>
          <a href="#/devices" aria-current={path === '/devices' ? 'page' : undefined}>
            Phones
          </a>
          <a href="#/fixtures" aria-current={path === '/fixtures' ? 'page' : undefined}>
            Fixtures
          </a>
          <a href="#/history" aria-current={path === '/history' ? 'page' : undefined}>
            Reliability
          </a>
        </nav>
      </header>
      <main>{children}</main>
    </>
  )
}
