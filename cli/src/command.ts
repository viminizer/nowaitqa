import type { z } from 'zod'
import type { Client } from './client.ts'

export const options = {
  json: { type: 'boolean', description: 'One JSON envelope on stdout, including errors' },
  help: { type: 'boolean', description: 'Describe this command without contacting the server' },
  server: { type: 'string', description: 'Server base URL (overrides NOWAIT_SERVER_URL)' },
  'request-timeout': { type: 'string', description: 'HTTP deadline in seconds (default 30)' },
  input: { type: 'string', description: 'JSON request file, checked against the shared schema' },
  output: { type: 'string', description: 'New local destination file; never overwritten' },
  page: { type: 'string', description: 'Zero-based attempt/manifest page' },
  before: { type: 'string', description: 'Runs cursor from the previous older field' },
  after: { type: 'string', description: 'Cursor from the previous next field' },
  status: { type: 'string', description: 'running, passed or failed' },
  query: { type: 'string', description: 'Run search text' },
  limit: { type: 'string', description: 'Runs per page, 1–50' },
  failed: { type: 'boolean', description: 'Retry only final failed scenarios' },
  timeout: {
    type: 'string',
    description: 'Total wait deadline in seconds (default 300, max 86400)',
  },
  'confirmed-stopped': {
    type: 'boolean',
    description: 'Explicitly assert previous execution and requests have stopped',
  },
  host: { type: 'string', description: 'Runner machine name' },
  key: { type: 'string', description: 'Exact target key from setup targets' },
  boot: {
    type: 'boolean',
    description: 'Explicit permission to start the selected virtual device',
  },
  'queue-id': { type: 'string', description: 'Filter fixture records by attempt queue ID' },
  platform: { type: 'string', description: 'android or ios' },
  days: { type: 'string', description: 'History interval: 7, 30 or 90 days' },
  until: { type: 'string', description: 'Freeze history window with its returned until timestamp' },
} as const

export type Values = Partial<Record<keyof typeof options, string | boolean>>
export const text = (values: Values, key: keyof typeof options) => {
  const value = values[key]
  return typeof value === 'string' ? value : undefined
}
export type Context = { client: Client; signal: AbortSignal; args: string[]; values: Values }
export type Command = {
  name: string
  summary: string
  args: string[]
  options: (keyof typeof options)[]
  mutates: boolean
  inputSchema?: z.ZodType
  run: (context: Context) => Promise<unknown>
}
