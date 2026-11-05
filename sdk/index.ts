// What a test repo needs from nowait-qa: the Scenario type, and how scenario files are found.
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Browser } from 'webdriverio'

export type Scenario = {
  id: string
  platforms: ('android' | 'ios')[]
  run: (
    driver: Browser,
    account: { username: string; password: string } | null,
    context: { signal: AbortSignal },
  ) => Promise<void>
}

// Every .ts file directly in dir is one scenario, and its id is the file name. Sub-folders
// (helpers) are skipped.
export async function loadScenarios(dir: string): Promise<Scenario[]> {
  const files = (await readdir(dir, { withFileTypes: true }))
    .filter((f) => f.isFile() && f.name.endsWith('.ts'))
    .map((f) => f.name)
  return Promise.all(
    files.map(async (file) => {
      const scenario: Scenario = (await import(pathToFileURL(resolve(join(dir, file))).href))
        .default
      const id = file.replace(/\.ts$/, '')
      if (scenario?.id !== id) throw new Error(`${join(dir, file)}: id must be "${id}"`)
      return scenario
    }),
  )
}
