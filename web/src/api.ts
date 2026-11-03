import { useEffect, useEffectEvent, useState } from 'react'

const REFRESH_MS = 5000

export type ApiState<T> = { data?: T; error?: string }

const always = () => true

// Reads a dashboard API route, checks it with its shared schema (R5, R40), and reads it again every
// few seconds while `keepPolling(data)` is true. A hidden tab waits, and loads as soon as it is
// shown again. Pages start fresh through a `key` (R42). The browser sends the basic auth it asked
// for when the page loaded.
// ponytail: polling. Server-sent events if 5 s ever feels slow.
export function useApi<T>(
  path: string,
  schema: { parse: (data: unknown) => T },
  keepPolling: (data: T) => boolean = always,
): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({})
  // the latest schema and keepPolling, without restarting the effect when they are new functions
  const parse = useEffectEvent((data: unknown) => schema.parse(data))
  const shouldPoll = useEffectEvent((data: T) => keepPolling(data))

  useEffect(() => {
    const request = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let polling = true

    async function load() {
      clearTimeout(timer)
      if (document.hidden) return // onVisible() loads when the tab is shown
      try {
        const res = await fetch(`/dashboard/api${path}`, { signal: request.signal })
        if (!res.ok) {
          // a proxy in front of the server may answer with HTML, not our JSON error
          const body = await res.json().catch(() => null)
          throw new Error(body?.error ?? `the server answered ${res.status}`)
        }
        const data = parse(await res.json())
        setState({ data })
        polling = shouldPoll(data)
      } catch (err) {
        if (request.signal.aborted) return
        // keep the last data: a failed refresh shows an error above it
        setState((s) => ({ ...s, error: (err as Error).message }))
      }
      if (polling && !request.signal.aborted) timer = setTimeout(load, REFRESH_MS)
    }
    const onVisible = () => {
      if (!document.hidden && polling) load()
    }

    load()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      request.abort()
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [path])

  return state
}
