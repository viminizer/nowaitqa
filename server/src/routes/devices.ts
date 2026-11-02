import { Device } from '@nowait/shared'
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db } from '../db/index.ts'
import { devices } from '../db/schema.ts'

export const deviceRoutes: FastifyPluginAsyncZod = async (app) => {
  // The runner asks for the phones on its machine. A short list (one row per phone), not paged.
  app.get('/devices', { schema: { querystring: z.object({ host: z.string() }) } }, async (req) =>
    db.select().from(devices).where(eq(devices.host, req.query.host)),
  )

  // Add a phone, or change one: adding a phone is one call (the article's "add one entry").
  app.put('/devices', { schema: { body: Device } }, async (req) => {
    const [device] = await db
      .insert(devices)
      .values(req.body)
      .onConflictDoUpdate({ target: devices.name, set: req.body })
      .returning()
    return device
  })
}
