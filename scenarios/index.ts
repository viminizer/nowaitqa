// Finds every scenario file in this folder. One scenario per file, id = file name (R7).
import { readdir } from 'node:fs/promises'
import type { Platform } from '@nowait/shared'
import type { Browser } from 'webdriverio'

export type Scenario = {
  id: string
  platforms: Platform[]
  run: (driver: Browser, account: { username: string; password: string } | null) => Promise<void>
}

export async function loadScenarios(): Promise<Scenario[]> {
  const files = (await readdir(import.meta.dirname)).filter(
    (f) => f.endsWith('.ts') && f !== 'index.ts',
  )
  return Promise.all(
    files.map(async (file) => {
      const scenario: Scenario = (await import(`./${file}`)).default
      const id = file.replace(/\.ts$/, '')
      if (scenario?.id !== id) throw new Error(`scenarios/${file}: id must be "${id}"`)
      return scenario
    }),
  )
}
