import {
  ApiError,
  DbIdParam,
  SetupClaim,
  SetupContactBody,
  SetupContactReply,
  SetupCreateBody,
  SetupCreated,
  SetupFinishBody,
  SetupHostsPage,
  SetupHostsQuery,
  SetupJob,
  SetupOwner,
  SetupProgressBody,
  SetupReserveBody,
  SetupResolveBody,
  SetupTargetsPage,
  SetupTargetsQuery,
} from '@nowait/shared'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { BadDeviceError } from '../devices.ts'
import {
  cancelSetup,
  claimSetup,
  contactSetupHost,
  createSetup,
  finishSetup,
  getSetupJob,
  getSetupTargets,
  listSetupHosts,
  progressSetup,
  releaseSetupHost,
  reserveSetup,
  resolveSetup,
  SetupConflictError,
} from '../queue.ts'

export const setupRoutes: FastifyPluginAsyncZod = async (app) => {
  app.setErrorHandler((err, _req, reply) => {
    const pg = (err as { cause?: { code?: string } }).cause
    if (
      err instanceof SetupConflictError ||
      err instanceof BadDeviceError ||
      pg?.code === '23505' ||
      pg?.code === '23503'
    )
      return reply.code(err instanceof SetupConflictError ? 409 : 400).send({
        error:
          err instanceof SetupConflictError || err instanceof BadDeviceError
            ? err.message
            : 'registration or reservation conflicts with an existing record',
      })
    throw err
  })
  app.post(
    '/virtual/contact',
    { schema: { body: SetupContactBody, response: { 200: SetupContactReply, 409: ApiError } } },
    async (req) => contactSetupHost(req.body),
  )
  app.post('/virtual/release', { schema: { body: SetupOwner } }, async (req, reply) => {
    await releaseSetupHost(req.body)
    return reply.code(204).send()
  })
  app.post(
    '/virtual/claim',
    { schema: { body: SetupOwner, response: { 200: SetupClaim, 204: z.void(), 409: ApiError } } },
    async (req, reply) => (await claimSetup(req.body)) ?? reply.code(204).send(),
  )
  app.post('/virtual/progress', { schema: { body: SetupProgressBody } }, async (req, reply) =>
    reply.code((await progressSetup(req.body)) ? 204 : 409).send(),
  )
  app.post('/virtual/reserve', { schema: { body: SetupReserveBody } }, async (req, reply) => {
    await reserveSetup(req.body)
    return reply.code(204).send()
  })
  app.post('/virtual/finish', { schema: { body: SetupFinishBody } }, async (req, reply) => {
    await finishSetup(req.body)
    return reply.code(204).send()
  })
  for (const prefix of ['/virtual', '/dashboard/api/virtual']) {
    app.get(
      `${prefix}/hosts`,
      { schema: { querystring: SetupHostsQuery, response: { 200: SetupHostsPage } } },
      async (req) => listSetupHosts(req.query.after),
    )
    app.get(
      `${prefix}/targets`,
      {
        schema: {
          querystring: SetupTargetsQuery,
          response: { 200: SetupTargetsPage, 404: ApiError },
        },
      },
      async (req, reply) =>
        (await getSetupTargets(req.query.host, req.query.after)) ??
        reply.code(404).send({ error: 'runner machine not found' }),
    )
    app.post(
      `${prefix}/jobs`,
      { schema: { body: SetupCreateBody, response: { 201: SetupCreated, 409: ApiError } } },
      async (req, reply) => reply.code(201).send(await createSetup(req.body)),
    )
    app.get(
      `${prefix}/jobs/:id`,
      {
        schema: { params: z.object({ id: DbIdParam }), response: { 200: SetupJob, 404: ApiError } },
      },
      async (req, reply) =>
        (await getSetupJob(req.params.id)) ?? reply.code(404).send({ error: 'setup not found' }),
    )
    app.post(
      `${prefix}/jobs/:id/cancel`,
      { schema: { params: z.object({ id: DbIdParam }) } },
      async (req, reply) => reply.code((await cancelSetup(req.params.id)) ? 204 : 409).send(),
    )
    app.post(
      `${prefix}/jobs/:id/resolve`,
      { schema: { params: z.object({ id: DbIdParam }), body: SetupResolveBody } },
      async (req, reply) => {
        req.log.info(
          { setupId: req.params.id },
          'operator confirmed previous setup commands stopped',
        )
        await resolveSetup(req.params.id)
        return reply.code(204).send()
      },
    )
  }
}
