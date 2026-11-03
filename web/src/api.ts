import { useEffect, useState } from 'react'

const REFRESH_MS = 5000

export type ApiState<T> = { data?: T; error?: string }

// Reads a dashboard API route, checks it with its shared schema (R5), and reads it again every
// few seconds. The browser sends the basic auth it asked for when the page loaded.
// ponytail: polling. Server-sent events if 5 s ever feels slow.
export function useApi<T>(path: string, schema: { parse: (data: unknown) => T }): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({})

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    async function load() {
      try {
        const res = await fetch(`/dashboard/api${path}`)
        const body = await res.json()
        if (!res.ok) throw new Error(body.error ?? `the server answered ${res.status}`)
        if (!stopped) setState({ data: schema.parse(body) })
      } catch (err) {
        // keep the last data: a failed refresh shows an error above it
        if (!stopped) setState((s) => ({ ...s, error: (err as Error).message }))
      }
      if (!stopped) timer = setTimeout(load, REFRESH_MS)
    }
    setState({})
    load()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [path, schema])

  return state
}
