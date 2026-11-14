export class CliError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode = 1,
    public details?: { status?: number; outcome?: 'unknown'; data?: unknown },
  ) {
    super(message)
  }
}

// Data and diagnostics have separate streams; JSON mode always emits exactly one document.
export function success(data: unknown, json: boolean) {
  process.stdout.write(`${JSON.stringify(json ? { ok: true, data } : data, null, json ? 0 : 2)}\n`)
}

export function failure(error: unknown, json: boolean) {
  const err =
    error instanceof CliError ? error : new CliError('internal_error', 'Unexpected CLI failure')
  const body = { code: err.code, message: err.message, ...err.details }
  const text = json
    ? JSON.stringify({ ok: false, error: body })
    : `${err.code}: ${err.message.replace(/\p{Cc}/gu, ' ')}`
  ;(json ? process.stdout : process.stderr).write(`${text}\n`)
  process.exitCode = err.exitCode
}
