// Any S3-compatible store: AWS S3, or RustFS / MinIO through S3_ENDPOINT (path-style URLs then).
// Without keys in env, the SDK finds credentials itself (an IAM role on AWS).
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { ArtifactStore } from './store.ts'

type Settings = {
  bucket: string
  region: string
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
}

export function s3Store({ bucket, region, endpoint, accessKeyId, secretAccessKey }: Settings) {
  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle: Boolean(endpoint), // RustFS and MinIO serve buckets as /bucket/key
    // The SDK adds CRC checksums by default; some S3-compatible stores refuse them. Off AWS, only
    // send them where the API requires them.
    ...(endpoint
      ? {
          requestChecksumCalculation: 'WHEN_REQUIRED' as const,
          responseChecksumValidation: 'WHEN_REQUIRED' as const,
        }
      : {}),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    // a store that does not answer must not hang a result upload or the dashboard
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
  })

  const store: ArtifactStore = {
    name: 's3',
    async check() {
      await client.send(new HeadBucketCommand({ Bucket: bucket })).catch((err) => {
        // a HEAD answer has no body, so only its status says what is wrong
        const status = err.$metadata?.httpStatusCode
        const why =
          status === 404
            ? 'it does not exist (create it first)'
            : status === 403
              ? 'access denied (check the keys and the bucket policy)'
              : `${err.name}: ${err.message || err.code || err.errors?.[0]?.message || 'no answer'}`
        throw new Error(`S3 bucket ${bucket} can't be used: ${why}`)
      })
    },
    async save(key, data) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data }))
    },
    async read(key) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        if (!object.Body) return null
        const bytes = await object.Body.transformToByteArray()
        return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength) // no copy
      } catch (err) {
        // 404 by status too: not every S3-compatible store names it NoSuchKey. A 403 stays an
        // error: it means the keys or the policy are wrong, not that the file is gone.
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode
        if ((err as Error).name === 'NoSuchKey' || status === 404) return null
        throw err
      }
    },
    // S3 has no folders: list the run's keys a page (up to 1000) at a time and delete each page.
    async deleteRun(runId) {
      let token: string | undefined
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: `${runId}/`,
            ContinuationToken: token,
          }),
        )
        const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []))
        if (keys.length > 0) {
          const done = await client.send(
            new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }),
          )
          const failed = done.Errors?.[0]
          if (failed) throw new Error(`S3 could not delete ${failed.Key}: ${failed.Message}`)
        }
        token = page.NextContinuationToken
      } while (token)
    },
  }
  return store
}
