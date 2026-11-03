import { useEffect, useState } from 'react'

const REFRESH_MS = 5000

export type ApiState<T> = { data?: T; error?: string }

const always = () => true

// Reads a dashboard API route, checks it with its shared schema (R5, R40), and reads it again every
// few seconds while `keepPolling(data)` is true and the tab is visible. Give a page a `key` to start
// it fresh (R42). The browser sends the basic auth it asked for when the page loaded.
// ponytail: polling. Server-sent events if 5 s ever feels slow.
export function useApi<T>(
  path: string,
  schema: { parse: (data: unknown) => T },
  keepPolling: (data: T) => boolean = always, // pass a function defined outside the component
): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({})

  useEffect(() => {
    const request = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function load() {
      let poll = true
      if (!document.hidden) {
        try {
          const res = await fetch(`/dashboard/api${path}`, { signal: request.signal })
          if (!res.ok) {
            // a proxy in front of the server may answer with HTML, not our JSON error
            const body = await res.json().catch(() => null)
            throw new Error(body?.error ?? `the server answered ${res.status}`)
          }
          const data = schema.parse(await res.json())
          setState({ data })
          poll = keepPolling(data)
        } catch (err) {
          if (request.signal.aborted) return
          // keep the last data: a failed refresh shows an error above it
          setState((s) => ({ ...s, error: (err as Error).message }))
        }
      }
      if (poll && !request.signal.aborted) timer = setTimeout(load, REFRESH_MS)
    }
    load()
    return () => {
      request.abort()
      clearTimeout(timer)
    }
  }, [path, schema, keepPolling])

  return state
}
