import { timingSafeEqual } from 'node:crypto'
import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { deleteOldArtifacts } from './artifacts.ts'
import { config } from './config.ts'
import { runMigrations } from './db/index.ts'
import { expireLeases, expireRuns } from './queue.ts'
import { deviceRoutes } from './routes/devices.ts'
import { runRoutes } from './routes/runs.ts'
import { workRoutes } from './routes/work.ts'

const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 }) // results carry screenshots
app.setValidatorCompiler(validatorCompiler)
app.setSerializerCompiler(serializerCompiler)

// Every route except /health needs a token (R22). A leaked trigger token (Jenkins) can start
// runs, but cannot take work or report fake results.
const TRIGGER_ROUTES = ['/runs', '/runs/:id']
const isToken = (given: Buffer, token: string) => {
  const expected = Buffer.from(`Bearer ${token}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return
  const given = Buffer.from(req.headers.authorization ?? '')
  if (isToken(given, config.RUNNER_TOKEN)) return
  if (!isToken(given, config.TRIGGER_TOKEN)) {
    return reply.code(401).send({ error: 'unauthorized' })
  }
  if (!TRIGGER_ROUTES.includes(req.routeOptions.url ?? '')) {
    return reply.code(403).send({ error: 'the trigger token can only start and read runs' })
  }
})

app.get('/health', async () => ({ ok: true }))
await app.register(runRoutes)
await app.register(workRoutes)
await app.register(deviceRoutes)

await runMigrations()

// Background jobs. Errors are logged, and the next tick tries again.
setInterval(() => expireLeases().catch((err) => app.log.error(err, 'expireLeases failed')), 15_000)
setInterval(() => expireRuns().catch((err) => app.log.error(err, 'expireRuns failed')), 60_000)
setInterval(
  () => deleteOldArtifacts().catch((err) => app.log.error(err, 'deleteOldArtifacts failed')),
  24 * 60 * 60 * 1000,
)

await app.listen({ port: config.PORT, host: '0.0.0.0' })
