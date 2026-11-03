// The default store: files under ARTIFACT_DIR on the server's disk, one folder per run.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ArtifactStore } from './store.ts'

export function localStore(dir: string): ArtifactStore {
  const path = (key: string) => join(dir, key)
  return {
    name: 'local',
    async check() {
      await mkdir(dir, { recursive: true })
    },
    async save(key, data) {
      await mkdir(dirname(path(key)), { recursive: true })
      await writeFile(path(key), data)
    },
    read: (key) =>
      readFile(path(key)).catch((err) => {
        if (err.code === 'ENOENT') return null
        throw err
      }),
    deleteRun: (runId) => rm(join(dir, String(runId)), { recursive: true, force: true }),
  }
}
