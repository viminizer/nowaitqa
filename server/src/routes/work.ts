// The routes the runner calls: send its scenarios, take work, keep it alive, report it.
import {
  ApiError,
  Catalog,
  DevicePause,
  HeartbeatBody,
  InputRuntimeBody,
  Lease,
  LeaseBody,
  ResolvedInputs,
  ResultBody,
  RevisionPage,
  RevisionQuery,
  VerifyInputsBody,
} from '@nowait/shared'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import {
  heartbeat,
  InputConflictError,
  leaseNext,
  PausedDeviceError,
  recordInputRuntime,
  referencedRevisions,
  releaseLease,
  saveCatalog,
  submitResult,
  UnknownDeviceError,
  verifyInputs,
  waitForWork,
} from '../queue.ts'

const LONG_POLL_MS = 30_000

export const workRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/inputs',
    { schema: { body: VerifyInputsBody, response: { 200: ResolvedInputs, 409: ApiError } } },
    async (req, reply) => {
      try {
        return await verifyInputs(req.body.queueId, req.body.device, req.body.inputs)
      } catch (err) {
        if (err instanceof InputConflictError) return reply.code(409).send({ error: err.message })
        throw err
      }
    },
  )
  app.post(
    '/inputs/runtime',
    { schema: { body: InputRuntimeBody, response: { 204: z.void(), 409: ApiError } } },
    async (req, reply) => {
      try {
        await recordInputRuntime(req.body.queueId, req.body.device, req.body.runtime)
        return reply.code(204).send()
      } catch (err) {
        if (err instanceof InputConflictError) return reply.code(409).send({ error: err.message })
        throw err
      }
    },
  )
  app.get(
    '/catalog/revisions',
    { schema: { querystring: RevisionQuery, response: { 200: RevisionPage } } },
    async (req) => referencedRevisions(req.query.after),
  )
  // The runner's scenario list. The server never reads test files: runs are filled from this.
  app.put('/catalog', { schema: { body: Catalog } }, async (req, reply) => {
    await saveCatalog(req.body)
    return reply.code(204).send()
  })

  // Long poll: answers right away when there is work, otherwise waits up to 30s for some.
  app.post(
    '/lease',
    {
      schema: {
        body: LeaseBody,
        response: { 200: Lease, 204: z.void(), 404: ApiError, 423: DevicePause },
      },
    },
    async (req, reply) => {
      const deadline = Date.now() + LONG_POLL_MS
      // The request body is already complete; watch the response for a disconnected consumer.
      const controller = new AbortController()
      const abort = () => controller.abort()
      reply.raw.once('close', abort)
      if (reply.raw.destroyed) abort()
      try {
        while (true) {
          const lease = await leaseNext(
            req.body.device,
            req.body.commits,
            req.body.runId,
            controller.signal,
            req.body.cleanup,
            req.body.inputs,
            req.body.profiles,
          )
          if (lease) return lease
          const left = deadline - Date.now()
          if (left <= 0) return reply.code(204).send()
          await waitForWork(left, controller.signal)
        }
      } catch (err) {
        if (err === controller.signal.reason) return reply.hijack() // socket already closed
        if (err instanceof PausedDeviceError) {
          return reply.code(423).header('retry-after', err.retryAfterSeconds).send({
            error: 'device is paused',
            retryAfterSeconds: err.retryAfterSeconds,
          })
        }
        if (err instanceof UnknownDeviceError) return reply.code(404).send({ error: err.message })
        throw err
      } finally {
        reply.raw.removeListener('close', abort)
      }
    },
  )

  app.post('/heartbeat', { schema: { body: HeartbeatBody } }, async (req, reply) => {
    const alive = await heartbeat(req.body.queueId, req.body.device, req.body.scenarioStarted)
    return alive ? reply.code(204).send() : reply.code(409).send({ error: 'lease is gone' })
  })

  app.post('/release', { schema: { body: HeartbeatBody } }, async (req, reply) => {
    const released = await releaseLease(req.body.queueId, req.body.device)
    return released ? reply.code(204).send() : reply.code(409).send({ error: 'lease is gone' })
  })

  app.post('/results', { schema: { body: ResultBody } }, async (req, reply) => {
    let submitted: Awaited<ReturnType<typeof submitResult>>
    try {
      submitted = await submitResult(req.body)
    } catch (err) {
      if (err instanceof InputConflictError) return reply.code(409).send({ error: err.message })
      throw err
    }
    const { saved, problems } = submitted
    // the result is saved anyway; the store's trouble goes to the log too
    for (const problem of problems) req.log.error(`result ${req.body.queueId}: ${problem}`)
    return saved ? reply.code(204).send() : reply.code(409).send({ error: 'lease is gone' })
  })
}
