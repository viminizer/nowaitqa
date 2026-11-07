import { lazy, Suspense } from 'react'
import { useHashLocation } from '../lib/navigation.ts'
import { Loading } from '../ui/DataState.tsx'
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx'
import { AppShell } from './AppShell.tsx'

const RunsPage = lazy(() =>
  import('../features/runs/RunsPage.tsx').then((module) => ({ default: module.RunsPage })),
)
const RunPage = lazy(() =>
  import('../features/runs/RunPage.tsx').then((module) => ({ default: module.RunPage })),
)
const DevicesPage = lazy(() =>
  import('../features/devices/DevicesPage.tsx').then((module) => ({ default: module.DevicesPage })),
)
const FixturesPage = lazy(() =>
  import('../features/fixtures/FixturesPage.tsx').then((module) => ({
    default: module.FixturesPage,
  })),
)
const HistoryPage = lazy(() =>
  import('../features/reliability/HistoryPage.tsx').then((module) => ({
    default: module.HistoryPage,
  })),
)
export function App() {
  const { path, query, params } = useHashLocation()
  const runId = path.match(/^\/runs\/(\d+)$/)?.[1]
  const before = params.get('before')
  const page = Math.max(0, Number.parseInt(params.get('page') ?? '', 10) || 0)
  return (
    <AppShell path={path}>
      <ErrorBoundary key={`${path}?${query}`}>
        <Suspense fallback={<Loading />}>
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
        </Suspense>
      </ErrorBoundary>
    </AppShell>
  )
}
