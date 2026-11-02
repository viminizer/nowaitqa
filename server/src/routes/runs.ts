import { CreateRunBody } from '@nowait/shared'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { createRun, getRun } from '../queue.ts'

export const runRoutes: FastifyPluginAsyncZod = async (app) => {
  // Called by Jenkins when a build is ready.
  app.post('/runs', { schema: { body: CreateRunBody } }, async (req, reply) => {
    const id = await createRun(req.body)
    if (id === null) {
      return reply.code(400).send({ error: `no scenarios for platform ${req.body.platform}` })
    }
    return reply.code(201).send({ id })
  })

  app.get(
    '/runs/:id',
    { schema: { params: z.object({ id: z.coerce.number().int() }) } },
    async (req, reply) => {
      const run = await getRun(req.params.id)
      return run ?? reply.code(404).send({ error: 'run not found' })
    },
  )
}
