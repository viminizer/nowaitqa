// Where screenshots and logs live: S3 when S3_BUCKET is set, else the server's disk. Everything
// else saves and reads them only through the functions here (R9), with keys, never file paths.
import { and, eq, isNotNull, lt, or, sql } from 'drizzle-orm'
import { config } from '../config.ts'
import { db } from '../db/index.ts'
import { results, runs } from '../db/schema.ts'
import { localStore } from './local.ts'
import { s3Store } from './s3.ts'
import type { ArtifactStore } from './store.ts'

export const store: ArtifactStore = config.S3_BUCKET
  ? s3Store({
      bucket: config.S3_BUCKET,
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    })
  : localStore(config.ARTIFACT_DIR)

// Saves one screenshot or log of a run; returns the key the results row keeps.
export async function saveArtifact(runId: number, name: string, data: Buffer | string) {
  const key = `${runId}/${name}`
  await store.save(key, data)
  return key
}

export const readArtifact = (key: string) => store.read(key)

const CLEANUP_BATCH = 100

// Deletes the artifacts of runs older than ARTIFACT_DAYS, found in the database, so it works the
// same for every store. Files first, then the keys: if a delete fails, the run is found again.
export async function deleteOldArtifacts() {
  for (;;) {
    const old = await db
      .selectDistinct({ runId: results.runId })
      .from(results)
      .innerJoin(runs, eq(runs.id, results.runId))
      .where(
        and(
          lt(runs.createdAt, sql`now() - make_interval(days => ${config.ARTIFACT_DAYS})`),
          or(isNotNull(results.screenshot), isNotNull(results.log)),
        ),
      )
      .limit(CLEANUP_BATCH)
    for (const { runId } of old) {
      await store.deleteRun(runId)
      await db.update(results).set({ screenshot: null, log: null }).where(eq(results.runId, runId))
    }
    if (old.length < CLEANUP_BATCH) return
  }
}
