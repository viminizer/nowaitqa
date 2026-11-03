// The text of anything thrown: an Error's message, or the value itself (a string, an object).
export const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))
