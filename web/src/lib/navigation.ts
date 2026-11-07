import { CreatedLaunch, CreatedRun } from '@nowait/shared'
import { useSyncExternalStore } from 'react'

const onHashChange = (update: () => void) => {
  addEventListener('hashchange', update)
  return () => removeEventListener('hashchange', update)
}
export function useHashLocation() {
  const [path = '', query = ''] = useSyncExternalStore(onHashChange, () => location.hash)
    .slice(1)
    .split('?')
  return { path, query, params: new URLSearchParams(query) }
}
export const openRun = (answer: unknown) => {
  location.hash = `#/runs/${CreatedRun.parse(answer).id}`
}

export const openLaunch = (answer: unknown) => {
  location.hash = `#/launches/${CreatedLaunch.parse(answer).id}`
}
