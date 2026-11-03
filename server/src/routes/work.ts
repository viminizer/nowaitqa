// The routes the runner calls: send its scenarios, take work, keep it alive, report it.
import { Catalog, HeartbeatBody, LeaseBody, ResultBody } from '@nowait/shared'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import {
  heartbeat,
  leaseNext,
  saveCatalog,
  submitResult,
  UnknownDeviceError,
  waitForWork,
} from '../queue.ts'

const LONG_POLL_MS = 30_000

export const workRoutes: FastifyPluginAsyncZod = async (app) => {
  // The runner's scenario list. The server never reads test files: runs are filled from this.
  app.put('/catalog', { schema: { body: Catalog } }, async (req, reply) => {
    await saveCatalog(req.body)
    return reply.code(204).send()
  })

  // Long poll: answers right away when there is work, otherwise waits up to 30s for some.
  app.post('/lease', { schema: { body: LeaseBody } }, async (req, reply) => {
    const deadline = Date.now() + LONG_POLL_MS
    try {
      while (true) {
        const lease = await leaseNext(req.body.device, req.body.commit, req.body.runId)
        if (lease) return lease
        const left = deadline - Date.now()
        if (left <= 0) return reply.code(204).send()
        await waitForWork(left)
      }
    } catch (err) {
      if (err instanceof UnknownDeviceError) return reply.code(404).send({ error: err.message })
      throw err
    }
  })

  app.post('/heartbeat', { schema: { body: HeartbeatBody } }, async (req, reply) => {
    const alive = await heartbeat(req.body.queueId, req.body.device)
    return alive ? reply.code(204).send() : reply.code(409).send({ error: 'lease is gone' })
  })

  app.post('/results', { schema: { body: ResultBody } }, async (req, reply) => {
    const saved = await submitResult(req.body)
    return saved ? reply.code(204).send() : reply.code(409).send({ error: 'lease is gone' })
  })
}
