// Read-only routes for the dashboard (web/). The browser signs in with basic auth (see main.ts).
import { readFile } from 'node:fs/promises'
import { ApiError, AttemptPage, DbIdParam, DeviceList, RunDetail, RunList } from '@nowait/shared'
import { eq, getTableColumns, sql } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db } from '../db/index.ts'
import { devices, queue, results } from '../db/schema.ts'
import { getRunDetail, listAttempts, listRuns } from '../queue.ts'

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

  // An attempt's screenshot or log. The path comes from the database, never from the URL.
  app.get(
    '/dashboard/api/attempts/:queueId/:file',
    { schema: { params: z.object({ queueId: DbIdParam, file: z.enum(['screenshot', 'log']) }) } },
    async (req, reply) => {
      const result = await db.query.results.findFirst({
        where: eq(results.queueId, req.params.queueId),
      })
      const path = result?.[req.params.file]
      if (!path) return reply.code(404).send({ error: 'no such file' })
      const data = await readFile(path).catch((err) => {
        if (err.code === 'ENOENT') return null // deleted after ARTIFACT_DAYS
        throw err
      })
      if (!data) return reply.code(404).send({ error: 'the file was deleted' })
      return reply
        .type(req.params.file === 'screenshot' ? 'image/png' : 'text/plain; charset=utf-8')
        .send(data)
    },
  )
}
