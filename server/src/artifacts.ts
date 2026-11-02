// Screenshots and logs are saved only through saveArtifact() (R9).
// ponytail: local disk. Swap the body of these two functions for S3 when we need it.
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from './config.ts'

export async function saveArtifact(runId: number, name: string, data: Buffer | string) {
  const dir = join(config.ARTIFACT_DIR, String(runId))
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, data)
  return path
}

// Deletes run folders older than ARTIFACT_DAYS.
export async function deleteOldArtifacts() {
  const cutoff = Date.now() - config.ARTIFACT_DAYS * 24 * 60 * 60 * 1000
  const dirs = await readdir(config.ARTIFACT_DIR).catch((err) => {
    if (err.code === 'ENOENT') return [] // nothing saved yet
    throw err
  })
  for (const dir of dirs) {
    const path = join(config.ARTIFACT_DIR, dir)
    if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true })
  }
}
