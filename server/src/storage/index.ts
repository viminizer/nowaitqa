// Where screenshots and logs live: S3 when S3_BUCKET is set, else the server's disk. Everything
// else saves and reads them only through the functions here (R9), with keys, never file paths.
import { and, asc, eq, gt, isNotNull, lt, or, sql } from 'drizzle-orm'
import { config } from '../config.ts'
import { db } from '../db/index.ts'
import { results, runs } from '../db/schema.ts'
import { messageOf } from '../errors.ts'
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
const STORE_DOWN_AFTER = 3 // failures in a row: the store itself is down, not one run

// Deletes the artifacts of runs older than ARTIFACT_DAYS, found in the database, so it works the
// same for every store. Files first, then the keys: if a delete fails, the run is found again next
// time. One run that can't be deleted never stops the others (R51): they are tried in run order,
// and the failures are reported together at the end. After several failures in a row it checks the
// store itself, and stops only when the store is down.
export async function deleteOldArtifacts() {
  const failed: string[] = []
  let inARow = 0
  let after = 0
  for (;;) {
    const old = await db
      .selectDistinct({ runId: results.runId })
      .from(results)
      .innerJoin(runs, eq(runs.id, results.runId))
      .where(
        and(
          gt(results.runId, after),
          lt(runs.createdAt, sql`now() - make_interval(days => ${config.ARTIFACT_DAYS})`),
          or(isNotNull(results.screenshot), isNotNull(results.log)),
        ),
      )
      .orderBy(asc(results.runId))
      .limit(CLEANUP_BATCH)
    for (const { runId } of old) {
      after = runId
      try {
        await store.deleteRun(runId)
        await db
          .update(results)
          .set({ screenshot: null, log: null })
          .where(eq(results.runId, runId))
        inARow = 0
      } catch (err) {
        failed.push(`run ${runId}: ${messageOf(err)}`)
        // Several in a row: ask the store itself. Down: stop, instead of waiting out every run's
        // timeout. Fine: these runs are bad on their own, so go on (they must not block the rest).
        if (++inARow >= STORE_DOWN_AFTER) {
          await store.check().catch((down) => {
            throw new Error(`the store looks down, cleanup stopped: ${messageOf(down)}`)
          })
          inARow = 0
        }
      }
    }
    if (old.length < CLEANUP_BATCH) break
  }
  if (failed.length > 0) {
    const shown = failed.slice(0, 5).join('; ')
    throw new Error(`could not delete the artifacts of ${failed.length} runs: ${shown}`)
  }
}
