import { ACTION_HEADER, ApiError } from '@nowait/shared'
import type { z } from 'zod'
import type { loadConfig } from './config.ts'
import { CliError } from './output.ts'

const MAX_RESPONSE_BYTES = 20 * 1024 * 1024

export class Client {
  constructor(
    private config: ReturnType<typeof loadConfig>,
    private signal: AbortSignal,
  ) {}

  private async request(path: string, body?: unknown, signal?: AbortSignal) {
    const mutates = body !== undefined
    const signals = [this.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]
    if (signal) signals.push(signal)
    try {
      const response = await fetch(`${this.config.server}/dashboard/api${path}`, {
        method: mutates ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${this.config.token}`,
          ...(mutates ? { 'content-type': 'application/json', [ACTION_HEADER]: '1' } : {}),
        },
        body: mutates ? JSON.stringify(body) : undefined,
        signal: AbortSignal.any(signals),
        redirect: 'error',
      })
      const chunks: Uint8Array[] = []
      let size = 0
      if (response.body) {
        const reader = response.body.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > MAX_RESPONSE_BYTES)
              throw new CliError(
                'response_too_large',
                'Server response exceeds 20 MiB',
                1,
                mutates ? { outcome: 'unknown' } : undefined,
              )
            chunks.push(value)
          }
        } finally {
          await reader.cancel()
        }
      }
      const bytes = Buffer.concat(chunks)
      if (!response.ok) {
        // Only accept the API error shape, not a proxy HTML page. Redact this credential.
        let reason = `Server answered HTTP ${response.status}`
        try {
          const error = ApiError.safeParse(JSON.parse(bytes.toString('utf8')))
          if (error.success)
            reason += `: ${error.data.error.replaceAll(this.config.token, '[redacted]').slice(0, 4096)}`
        } catch {
          reason += '; response was not an API error'
        }
        const code =
          response.status === 401
            ? 'unauthorized'
            : response.status === 403
              ? 'forbidden'
              : response.status === 404
                ? 'not_found'
                : response.status === 409
                  ? 'conflict'
                  : response.status >= 500
                    ? 'server_error'
                    : 'request_rejected'
        throw new CliError(
          code,
          reason,
          response.status === 401 || response.status === 403 ? 3 : 1,
          {
            status: response.status,
            ...(mutates && response.status >= 500 ? { outcome: 'unknown' as const } : {}),
          },
        )
      }
      return { response, bytes, mutates }
    } catch (err) {
      if (err instanceof CliError) throw err
      throw new CliError(
        this.signal.aborted ? 'interrupted' : 'request_failed',
        mutates
          ? 'Request did not complete. It may have succeeded; inspect server state before retrying.'
          : 'Request did not complete; check the server, connection and timeout.',
        this.signal.aborted ? 130 : 1,
        mutates ? { outcome: 'unknown' } : undefined,
      )
    }
  }

  async json<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const { response, bytes, mutates } = await this.request(path, body, signal)
    try {
      return schema.parse(response.status === 204 ? null : JSON.parse(bytes.toString('utf8')))
    } catch {
      throw new CliError(
        'invalid_response',
        'Server response does not match the shared API contract',
        1,
        mutates ? { outcome: 'unknown' } : undefined,
      )
    }
  }

  async download(path: string, type: 'image/png' | 'text/plain') {
    const { response, bytes } = await this.request(path)
    if (!response.headers.get('content-type')?.startsWith(type))
      throw new CliError('invalid_response', `Expected ${type}`)
    return bytes
  }
}

export function query(path: string, values: Record<string, unknown>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) params.set(key, String(value))
  return `${path}?${params}`
}
