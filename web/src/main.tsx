import { StrictMode, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { DevicesPage } from './DevicesPage.tsx'
import { RunPage } from './RunPage.tsx'
import { RunsPage } from './RunsPage.tsx'
import './style.css'
import { ErrorBoundary } from './ui.tsx'

// Pages live in the URL hash (#/runs/5), so the server only serves one index.html.
const onHashChange = (update: () => void) => {
  addEventListener('hashchange', update)
  return () => removeEventListener('hashchange', update)
}

function App() {
  const [path = '', query] = useSyncExternalStore(onHashChange, () => location.hash)
    .slice(1)
    .split('?')
  const runId = path.match(/^\/runs\/(\d+)$/)?.[1]
  const before = new URLSearchParams(query).get('before')

  return (
    <>
      <header>
        <a className="brand" href="#/">
          nowait-qa
        </a>
        <nav>
          <a href="#/" aria-current={path === '/' || path === '' ? 'page' : undefined}>
            Runs
          </a>
          <a href="#/devices" aria-current={path === '/devices' ? 'page' : undefined}>
            Phones
          </a>
        </nav>
      </header>
      <main>
        {/* the key: another page, run or `before` starts fresh, errors included (R42) */}
        <ErrorBoundary key={`${path}?${query}`}>
          {runId ? (
            <RunPage id={Number(runId)} />
          ) : path === '/devices' ? (
            <DevicesPage />
          ) : (
            <RunsPage before={before} />
          )}
        </ErrorBoundary>
      </main>
    </>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('index.html has no #root')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
