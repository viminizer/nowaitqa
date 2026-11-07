import type { ReactNode } from 'react'
import { Icon } from '../ui/Icon.tsx'

export function AppShell({ path, children }: { path: string; children: ReactNode }) {
  const runId = path.match(/^\/runs\/(\d+)$/)?.[1]
  const section =
    path === '/devices'
      ? 'Phones'
      : path === '/fixtures'
        ? 'Fixtures'
        : path === '/history'
          ? 'Reliability'
          : 'Runs'
  return (
    <div className="workspace-shell" data-layout="compact">
      <header className="app-header">
        <a className="brand" href="#/">
          <span className="brand-mark">N</span>nowait<span className="brand-slash"> /</span>
        </a>
        <div className="workspace-label">
          <span className="workspace-mark">NQ</span>
          <div>
            Mobile QA<small>Nowait workspace</small>
          </div>
        </div>
        <nav className="workspace-navigation" aria-label="Workspace">
          <a href="#/" aria-current={section === 'Runs' ? 'page' : undefined}>
            <Icon name="runs" />
            Runs
          </a>
          <a href="#/devices" aria-current={section === 'Phones' ? 'page' : undefined}>
            <Icon name="phone" />
            Phones
          </a>
          <a href="#/fixtures" aria-current={section === 'Fixtures' ? 'page' : undefined}>
            <Icon name="fixtures" />
            Fixtures
          </a>
          <a href="#/history" aria-current={section === 'Reliability' ? 'page' : undefined}>
            <Icon name="history" />
            Reliability
          </a>
        </nav>
        <p className="workspace-caption">
          Mobile testing,
          <br />
          in order.
        </p>
      </header>
      <div className="workspace-content">
        <div className="workspace-topbar">
          <div>
            <span>Workspace</span>
            <span>/</span>
            <strong>{section}</strong>
            {runId && (
              <>
                <span>/</span>
                <strong>#{runId}</strong>
              </>
            )}
          </div>
          <span>{runId ? 'Saved run evidence' : 'Automatic refresh · 5s'}</span>
        </div>
        <main>{children}</main>
      </div>
    </div>
  )
}
