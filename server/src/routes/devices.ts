import { DeviceBody, DeviceContactBody } from '@nowait/shared'
import { eq } from 'drizzle-orm'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { db } from '../db/index.ts'
import { devices } from '../db/schema.ts'
import { BadDeviceError, noteDeviceContact, registerDevice } from '../devices.ts'

export const deviceRoutes: FastifyPluginAsyncZod = async (app) => {
  // The runner asks for the phones on its machine. Bounded by the phones one machine can hold, so
  // not paged (R24 exception).
  app.get('/devices', { schema: { querystring: z.object({ host: z.string() }) } }, async (req) =>
    db.select().from(devices).where(eq(devices.host, req.query.host)),
  )

  app.post('/devices/contact', { schema: { body: DeviceContactBody } }, async (req, reply) => {
    const found = await noteDeviceContact(req.body)
    return found
      ? reply.code(204).send()
      : reply.code(404).send({ error: 'device identity not found' })
  })

  // Add a phone, or change one: adding a phone is one call (the article's "add one entry").
  app.put('/devices', { schema: { body: DeviceBody } }, async (req, reply) => {
    try {
      return await registerDevice(req.body, 'upsert')
    } catch (err) {
      if (err instanceof BadDeviceError) return reply.code(400).send({ error: err.message })
      throw err
    }
  })
}
