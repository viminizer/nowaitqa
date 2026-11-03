// The one interface every place that keeps screenshots and logs implements: the server's disk
// (default) and S3. Kevin asked for it, like the notifiers, so more can be added the same way.
// Keys look like "<runId>/<scenarioId>-<slot>-<attempt>.png"; the database stores the key.
export interface ArtifactStore {
  name: string
  // At startup: stops the server with a clear message when the store can't be used.
  check(): Promise<void>
  save(key: string, data: Buffer | string): Promise<void>
  // null when it is gone (deleted after ARTIFACT_DAYS, or by hand)
  read(key: string): Promise<Buffer<ArrayBuffer> | null>
  // every artifact of one run
  deleteRun(runId: number): Promise<void>
}
