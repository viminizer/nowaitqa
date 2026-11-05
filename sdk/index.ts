// What a test repo needs from nowait-qa: the Scenario type, and how scenario files are found.
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Browser } from 'webdriverio'

export type TestAccount = { username: string; password: string }
export type FixtureContext = {
  attemptId: number
  key: string
  account: TestAccount | null
  signal: AbortSignal
}
// Both operations must be idempotent and scoped to key. Cleanup verifies absence, including
// resources created by a setup whose response was lost. Returned setup values are never stored.
export type Fixture<T> = {
  name: string
  setup: (context: FixtureContext) => Promise<T>
  cleanup: (context: FixtureContext) => Promise<boolean>
}
export type AttemptContext = {
  attemptId: number
  signal: AbortSignal
  use: <T>(fixture: Fixture<T>) => Promise<T>
}

export type Scenario = {
  id: string
  platforms: ('android' | 'ios')[]
  fixtures?: readonly Fixture<unknown>[]
  run: (driver: Browser, account: TestAccount | null, context: AttemptContext) => Promise<void>
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
      if (
        scenario.fixtures !== undefined &&
        (!Array.isArray(scenario.fixtures) ||
          scenario.fixtures.some(
            (f) =>
              !f ||
              typeof f.name !== 'string' ||
              typeof f.setup !== 'function' ||
              typeof f.cleanup !== 'function',
          ) ||
          new Set(scenario.fixtures.map((f) => f.name)).size !== scenario.fixtures.length)
      )
        throw new Error(`${file}: fixtures need unique names, setup and cleanup functions`)
      return scenario
    }),
  )
}
