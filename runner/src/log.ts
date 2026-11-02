// One log line format for the whole runner: time, which phone (or machine), message.
export function log(source: string, message: string, err?: unknown) {
  console.log(`[${new Date().toISOString()}] [${source}] ${message}`, err ?? '')
}
