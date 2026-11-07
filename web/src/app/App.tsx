import { lazy, Suspense } from 'react'
import { useHashLocation } from '../lib/navigation.ts'
import { Loading } from '../ui/DataState.tsx'
import { ErrorBoundary } from '../ui/ErrorBoundary.tsx'
import { AppShell } from './AppShell.tsx'

const RunsPage = lazy(() =>
  import('../features/runs/RunsPage.tsx').then((module) => ({ default: module.RunsPage })),
)
const LaunchPage = lazy(() =>
  import('../features/runs/LaunchPage.tsx').then((module) => ({ default: module.LaunchPage })),
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
  const launchId = path.match(/^\/launches\/([^/]+)$/)?.[1]
  const runId = path.match(/^\/runs\/(\d+)$/)?.[1]
  const page = Math.max(0, Number.parseInt(params.get('page') ?? '', 10) || 0)
  return (
    <AppShell path={path}>
      <ErrorBoundary key={`${path}?${query}`}>
        <Suspense fallback={<Loading />}>
          {launchId ? (
            <LaunchPage id={launchId} />
          ) : runId ? (
            <RunPage id={Number(runId)} page={page} view={params.get('view') ?? 'overview'} />
          ) : path === '/history' ? (
            <HistoryPage params={params} />
          ) : path === '/fixtures' ? (
            <FixturesPage after={params.get('after')} queueId={params.get('queueId')} />
          ) : path === '/devices' ? (
            <DevicesPage />
          ) : (
            <RunsPage params={params} />
          )}
        </Suspense>
      </ErrorBoundary>
    </AppShell>
  )
}
