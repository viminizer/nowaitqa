import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { queryClient } from './api.ts'
import { DevicesPage } from './DevicesPage.tsx'
import { FixturesPage } from './FixturesPage.tsx'
import { HistoryPage } from './HistoryPage.tsx'
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
  const params = new URLSearchParams(query)
  const before = params.get('before')
  const page = Math.max(0, Number.parseInt(params.get('page') ?? '', 10) || 0)

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
          <a href="#/fixtures" aria-current={path === '/fixtures' ? 'page' : undefined}>
            Fixtures
          </a>
          <a href="#/history" aria-current={path === '/history' ? 'page' : undefined}>
            Reliability
          </a>
        </nav>
      </header>
      <main>
        {/* the key: another page, run or `before` clears a render error (R42); data is cached by URL */}
        <ErrorBoundary key={`${path}?${query}`}>
          {runId ? (
            <RunPage id={Number(runId)} page={page} />
          ) : path === '/history' ? (
            <HistoryPage params={params} />
          ) : path === '/fixtures' ? (
            <FixturesPage after={params.get('after')} queueId={params.get('queueId')} />
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
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
