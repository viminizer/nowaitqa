import { DeviceBody } from '@nowait/shared'
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db } from '../db/index.ts'
import { devices } from '../db/schema.ts'

export const deviceRoutes: FastifyPluginAsyncZod = async (app) => {
  // The runner asks for the phones on its machine. Bounded by the phones one machine can hold, so
  // not paged (R24 exception).
  app.get('/devices', { schema: { querystring: z.object({ host: z.string() }) } }, async (req) =>
    db.select().from(devices).where(eq(devices.host, req.query.host)),
  )

  // Add a phone, or change one: adding a phone is one call (the article's "add one entry").
  app.put('/devices', { schema: { body: DeviceBody } }, async (req, reply) => {
    try {
      const [device] = await db
        .insert(devices)
        .values(req.body)
        .onConflictDoUpdate({ target: devices.name, set: req.body })
        .returning()
      return device
    } catch (err) {
      // Drizzle wraps the Postgres error; 23505 = unique value already taken.
      const pg = (err as { cause?: { code?: string; constraint?: string } }).cause
      if (pg?.code === '23505' && pg.constraint === 'devices_udid_unique') {
        return reply
          .code(400)
          .send({ error: `udid ${req.body.udid} already belongs to another phone` })
      }
      throw err
    }
  })
}
