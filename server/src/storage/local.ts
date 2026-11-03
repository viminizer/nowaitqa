// The default store: files under ARTIFACT_DIR on the server's disk, one folder per run.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ArtifactStore } from './store.ts'

export function localStore(dir: string): ArtifactStore {
  const path = (key: string) => join(dir, key)
  return {
    name: 'local',
    async check() {
      await mkdir(dir, { recursive: true })
    },
    // A temp file, then a rename: two tries of one result can save the same key at once (the runner
    // retries), and a reader must never see a half-written file.
    async save(key, data) {
      await mkdir(dirname(path(key)), { recursive: true })
      const temp = `${path(key)}.${randomUUID()}.tmp`
      await writeFile(temp, data)
      await rename(temp, path(key))
    },
    read: (key) =>
      readFile(path(key)).catch((err) => {
        if (err.code === 'ENOENT') return null
        throw err
      }),
    deleteRun: (runId) => rm(join(dir, String(runId)), { recursive: true, force: true }),
  }
}
