// The text of anything thrown: an Error's message, or its name or code when the message is empty
// (some S3 SDK errors have none), or the value itself (a string, an object).
export function messageOf(err: unknown) {
  if (!(err instanceof Error)) return String(err)
  return err.message || (err as { code?: string }).code || err.name
}
