import { ApiError, CreatedRun, CreateRunBody, DbIdParam, RunSummary } from '@nowait/shared'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { BadRunError, createRun, getRun } from '../queue.ts'

export const runRoutes: FastifyPluginAsyncZod = async (app) => {
  // Called by Jenkins when a build is ready.
  app.post(
    '/runs',
    { schema: { body: CreateRunBody, response: { 201: CreatedRun, 400: ApiError } } },
    async (req, reply) => {
      try {
        return reply.code(201).send({ id: await createRun(req.body) })
      } catch (err) {
        if (err instanceof BadRunError) return reply.code(400).send({ error: err.message })
        throw err
      }
    },
  )

  app.get(
    '/runs/:id',
    {
      schema: {
        params: z.object({ id: DbIdParam }),
        response: { 200: RunSummary, 404: ApiError },
      },
    },
    async (req, reply) => {
      const run = await getRun(req.params.id)
      return run ?? reply.code(404).send({ error: 'run not found' })
    },
  )
}
