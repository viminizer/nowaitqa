import {
  ApiError,
  DbIdParam,
  FixtureClaimBody,
  FixtureFinishBody,
  FixtureJob,
  FixtureKey,
  FixturePage,
  FixtureQuery,
  FixtureRegisterBody,
  FixtureRetryBody,
} from '@nowait/shared'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import {
  BadRunError,
  claimFixture,
  FixtureConflictError,
  finishFixture,
  listFixtures,
  registerFixture,
  retryFixture,
} from '../queue.ts'

export const fixtureRoutes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    '/fixtures/register',
    { schema: { body: FixtureRegisterBody, response: { 200: FixtureKey, 409: ApiError } } },
    async (req, reply) => {
      try {
        return await registerFixture(req.body)
      } catch (err) {
        if (err instanceof FixtureConflictError) return reply.code(409).send({ error: err.message })
        throw err
      }
    },
  )
  app.post(
    '/fixtures/claim',
    { schema: { body: FixtureClaimBody, response: { 200: FixtureJob, 204: z.void() } } },
    async (req, reply) => {
      const job = await claimFixture(req.body)
      return job ?? reply.code(204).send()
    },
  )
  app.post('/fixtures/finish', { schema: { body: FixtureFinishBody } }, async (req, reply) => {
    return (await finishFixture(req.body))
      ? reply.code(204).send()
      : reply.code(409).send({ error: 'cleanup claim is unavailable' })
  })
  for (const path of ['/fixtures', '/dashboard/api/fixtures']) {
    app.get(
      path,
      { schema: { querystring: FixtureQuery, response: { 200: FixturePage } } },
      async (req) => listFixtures(req.query.after, req.query.queueId),
    )
    app.post(
      `${path}/:id/retry`,
      {
        schema: {
          params: z.object({ id: DbIdParam }),
          body: FixtureRetryBody,
          response: { 204: z.void(), 400: ApiError },
        },
      },
      async (req, reply) => {
        req.log.info(
          { fixtureId: req.params.id },
          'operator confirmed old execution and backend requests stopped; retry cleanup',
        )
        try {
          await retryFixture(req.params.id)
          return reply.code(204).send()
        } catch (err) {
          if (err instanceof BadRunError) return reply.code(400).send({ error: err.message })
          throw err
        }
      },
    )
  }
}
