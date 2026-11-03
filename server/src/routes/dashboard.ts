// Routes for the dashboard (web/): reads, and a few actions. The browser signs in with basic auth,
// and actions must send ACTION_HEADER (see main.ts).
import {
  ApiError,
  AttemptPage,
  CreatedRun,
  DbIdParam,
  DeviceEnabledBody,
  DeviceList,
  RunAgainBody,
  RunDetail,
  RunList,
} from '@nowait/shared'
import { eq, getTableColumns, sql } from 'drizzle-orm'
import type { FastifyReply } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db } from '../db/index.ts'
import { devices, queue, results } from '../db/schema.ts'
import {
  BadRunError,
  cancelRun,
  getRunDetail,
  listAttempts,
  listRuns,
  retryAttempt,
  runAgain,
  setDeviceEnabled,
} from '../queue.ts'
import { readArtifact } from '../storage/index.ts'

export const dashboardRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/dashboard/api/runs',
    {
      schema: {
        querystring: z.object({ before: DbIdParam.optional() }),
        response: { 200: RunList },
      },
    },
    async (req) => listRuns(req.query.before),
  )

  app.get(
    '/dashboard/api/runs/:id',
    {
      schema: { params: z.object({ id: DbIdParam }), response: { 200: RunDetail, 404: ApiError } },
    },
    async (req, reply) =>
      (await getRunDetail(req.params.id)) ?? reply.code(404).send({ error: 'run not found' }),
  )

  app.get(
    '/dashboard/api/runs/:id/attempts',
    {
      schema: {
        params: z.object({ id: DbIdParam }),
        querystring: z.object({ page: z.coerce.number().int().min(0).max(100_000).default(0) }),
        response: { 200: AttemptPage, 404: ApiError },
      },
    },
    async (req, reply) =>
      (await listAttempts(req.params.id, req.query.page)) ??
      reply.code(404).send({ error: 'run not found' }),
  )

  // Every phone on every machine: bounded by the hardware, so not paged (R24 exception).
  app.get('/dashboard/api/devices', { schema: { response: { 200: DeviceList } } }, async () => {
    // Both read through an index (queue_leased_idx, results_device_idx), not the whole history.
    const [phones, leased] = await Promise.all([
      db
        .select({
          ...getTableColumns(devices),
          lastWorkAt: sql<Date | null>`(
            select max(${results.createdAt}) from ${results} where ${results.device} = ${devices.name}
          )`.mapWith(results.createdAt),
        })
        .from(devices)
        .orderBy(devices.name),
      db
        .select({ device: queue.device, runId: queue.runId, scenarioId: queue.scenarioId })
        .from(queue)
        .where(eq(queue.status, 'leased')),
    ])
    return {
      devices: phones.map((phone) => {
        const busy = leased.find((l) => l.device === phone.name)
        return { ...phone, busy: busy ? { runId: busy.runId, scenarioId: busy.scenarioId } : null }
      }),
    }
  })

  // An attempt's screenshot or log. The key comes from the database, never from the URL.
  app.get(
    '/dashboard/api/attempts/:queueId/:file',
    { schema: { params: z.object({ queueId: DbIdParam, file: z.enum(['screenshot', 'log']) }) } },
    async (req, reply) => {
      const result = await db.query.results.findFirst({
        where: eq(results.queueId, req.params.queueId),
      })
      const key = result?.[req.params.file]
      if (!key) return reply.code(404).send({ error: 'no such file' })
      const data = await readArtifact(key)
      if (!data) return reply.code(404).send({ error: 'the file was deleted' })
      return reply
        .type(req.params.file === 'screenshot' ? 'image/png' : 'text/plain; charset=utf-8')
        .send(data)
    },
  )

  // --- actions: each one is logged, so the server log tells who changed what and when ---

  // A new run from an old one. A refusal (still running, nothing failed, no phones) is a 400.
  const started = async (start: Promise<number | null>, reply: FastifyReply) => {
    try {
      const id = await start
      return id === null
        ? reply.code(404).send({ error: 'not found' })
        : reply.code(201).send({ id })
    } catch (err) {
      if (err instanceof BadRunError) return reply.code(400).send({ error: err.message })
      throw err
    }
  }

  app.post(
    '/dashboard/api/runs/:id/again',
    {
      schema: {
        params: z.object({ id: DbIdParam }),
        body: RunAgainBody,
        response: { 201: CreatedRun, 400: ApiError, 404: ApiError },
      },
    },
    async (req, reply) => {
      const sent = await started(runAgain(req.params.id, req.body.failedOnly), reply)
      req.log.info(
        `dashboard: run ${req.params.id} again (failedOnly ${req.body.failedOnly}): ${reply.statusCode}`,
      )
      return sent
    },
  )

  app.post(
    '/dashboard/api/attempts/:queueId/again',
    {
      schema: {
        params: z.object({ queueId: DbIdParam }),
        response: { 201: CreatedRun, 400: ApiError, 404: ApiError },
      },
    },
    async (req, reply) => {
      const sent = await started(retryAttempt(req.params.queueId), reply)
      req.log.info(`dashboard: attempt ${req.params.queueId} again: ${reply.statusCode}`)
      return sent
    },
  )

  app.post(
    '/dashboard/api/runs/:id/cancel',
    {
      schema: {
        params: z.object({ id: DbIdParam }),
      },
    },
    async (req, reply) => {
      const cancelled = await cancelRun(req.params.id)
      req.log.info(`dashboard: cancel run ${req.params.id}: ${cancelled}`)
      if (cancelled === null) return reply.code(404).send({ error: 'run not found' })
      if (!cancelled) return reply.code(409).send({ error: 'the run is already finished' })
      return reply.code(204).send()
    },
  )

  app.post(
    '/dashboard/api/devices/:name/enabled',
    {
      schema: {
        params: z.object({ name: z.string().min(1) }),
        body: DeviceEnabledBody,
      },
    },
    async (req, reply) => {
      const found = await setDeviceEnabled(req.params.name, req.body.enabled)
      req.log.info(`dashboard: phone ${req.params.name} enabled ${req.body.enabled}: ${found}`)
      if (!found) return reply.code(404).send({ error: 'phone not found' })
      return reply.code(204).send()
    },
  )
}
