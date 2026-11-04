import { ACTION_HEADER } from '@nowait/shared'
import { QueryClient, useMutation, useQuery } from '@tanstack/react-query'

const REFRESH_MS = 5000

// No retries: polling refreshes anyway, and a 404 or a schema error fails the same way again.
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

// The reason a request failed. A proxy in front of the server may answer with HTML, not our JSON
// error; a 400 from input checks has the reason in `message`.
async function failure(res: Response) {
  const body = await res.json().catch(() => null)
  return new Error(body?.message ?? body?.error ?? `the server answered ${res.status}`)
}

// Reads a dashboard API route with TanStack Query, checks it with its shared schema (R5, R40), and
// reads it again every few seconds until `keepPolling(data)` says no (a finished run); from then on
// the data never goes stale. TanStack cancels the request when the page goes away, pauses polling in
// a hidden tab, and refreshes when it is shown again. The browser sends the basic auth it asked for
// when the page loaded.
export function useApi<T>(
  path: string,
  schema: { parse: (data: unknown) => T },
  keepPolling?: (data: T) => boolean,
) {
  const done = (data?: T) => data !== undefined && keepPolling?.(data) === false
  return useQuery({
    queryKey: [path],
    queryFn: async ({ signal }) => {
      const res = await fetch(`/dashboard/api${path}`, { signal })
      if (!res.ok) throw await failure(res)
      return schema.parse(await res.json())
    },
    refetchInterval: (query) => (done(query.state.data) ? false : REFRESH_MS),
    staleTime: (query) => (done(query.state.data) ? Number.POSITIVE_INFINITY : 0),
  })
}

// Posts an action once, then refreshes page data in the background. A slow read must not delay
// successful navigation, and an offline action must fail rather than wait to replay later.
// Resolves with the answer's JSON (null for 204).
export function useAction() {
  return useMutation({
    networkMode: 'always',
    retry: false,
    mutationFn: async ({ path, body = {} }: { path: string; body?: object }) => {
      const res = await fetch(`/dashboard/api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [ACTION_HEADER]: '1' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw await failure(res)
      return res.status === 204 ? null : ((await res.json()) as unknown)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries()
    },
  })
}
