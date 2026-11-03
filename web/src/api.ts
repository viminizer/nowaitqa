import { QueryClient, useQuery } from '@tanstack/react-query'

const REFRESH_MS = 5000

export const queryClient = new QueryClient({
  // polling refreshes anyway, so one quick retry is enough
  defaultOptions: { queries: { retry: 1 } },
})

const always = () => true

// Reads a dashboard API route with TanStack Query, checks it with its shared schema (R5, R40), and
// reads it again every few seconds while `keepPolling(data)` is true. TanStack cancels the request
// when the page goes away, pauses polling in a hidden tab, and refreshes when it is shown again.
// The browser sends the basic auth it asked for when the page loaded.
export function useApi<T>(
  path: string,
  schema: { parse: (data: unknown) => T },
  keepPolling: (data: T) => boolean = always,
) {
  return useQuery({
    queryKey: [path],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/dashboard/api${path}`, { signal })
      if (!res.ok) {
        // a proxy in front of the server may answer with HTML, not our JSON error
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `the server answered ${res.status}`)
      }
      return schema.parse(await res.json())
    },
    refetchInterval: (query) =>
      query.state.data && !keepPolling(query.state.data) ? false : REFRESH_MS,
  })
}
