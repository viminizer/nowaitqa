import { ApiError, CreateRunBody, RunSummary } from '@nowait/shared'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { BadRunError, createRun, getRun } from '../queue.ts'

export const runRoutes: FastifyPluginAsyncZod = async (app) => {
  // Called by Jenkins when a build is ready.
  app.post('/runs', { schema: { body: CreateRunBody } }, async (req, reply) => {
    try {
      return reply.code(201).send({ id: await createRun(req.body) })
    } catch (err) {
      if (err instanceof BadRunError) return reply.code(400).send({ error: err.message })
      throw err
    }
  })

  app.get(
    '/runs/:id',
    // RunSummary: the response drops the attempts, which only the dashboard needs
    {
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        response: { 200: RunSummary, 404: ApiError },
      },
    },
    async (req, reply) => {
      const run = await getRun(req.params.id)
      return run ?? reply.code(404).send({ error: 'run not found' })
    },
  )
}
