import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { deleteOldArtifacts } from './artifacts.ts'
import { config } from './config.ts'
import { runMigrations } from './db/index.ts'
import { expireLeases, expireRuns } from './queue.ts'
import { dashboardRoutes } from './routes/dashboard.ts'
import { deviceRoutes } from './routes/devices.ts'
import { runRoutes } from './routes/runs.ts'
import { workRoutes } from './routes/work.ts'

const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 }) // results carry screenshots
app.setValidatorCompiler(validatorCompiler)
app.setSerializerCompiler(serializerCompiler)

// Every route except /health needs a token or the dashboard password (R22). A leaked trigger token
// (Jenkins) can start runs, but cannot take work or report fake results.
const TRIGGER_ROUTES = ['/runs', '/runs/:id']
const matches = (given: string, expected: string) => {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
// Basic auth: base64 of "user:password". Any user name; only the password is checked.
const isDashboardPassword = (header: string) => {
  if (!header.startsWith('Basic ')) return false
  const pair = Buffer.from(header.slice(6), 'base64').toString()
  const colon = pair.indexOf(':')
  return colon >= 0 && matches(pair.slice(colon + 1), config.DASHBOARD_PASSWORD)
}
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return
  const given = req.headers.authorization ?? ''
  // The browser can't send a Bearer token on a link, so the dashboard uses basic auth instead.
  // Decided by the matched route, not the raw URL (/%64ashboard matches the same route).
  if (req.routeOptions.url?.startsWith('/dashboard')) {
    if (isDashboardPassword(given)) return
    return reply
      .code(401)
      .header('www-authenticate', 'Basic realm="nowait-qa"')
      .send({ error: 'unauthorized' })
  }
  if (matches(given, `Bearer ${config.RUNNER_TOKEN}`)) return
  if (!matches(given, `Bearer ${config.TRIGGER_TOKEN}`)) {
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
await app.register(dashboardRoutes)

// The dashboard's built files, behind the same basic auth. Checked at startup: build before starting.
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url))
if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST, prefix: '/dashboard', redirect: true })
} else {
  app.log.warn('the dashboard is not built: run pnpm --filter @nowait/web build, then restart')
}

await runMigrations()

// Background jobs. Errors are logged, and the next tick tries again.
setInterval(() => expireLeases().catch((err) => app.log.error(err, 'expireLeases failed')), 15_000)
setInterval(() => expireRuns().catch((err) => app.log.error(err, 'expireRuns failed')), 60_000)
setInterval(
  () => deleteOldArtifacts().catch((err) => app.log.error(err, 'deleteOldArtifacts failed')),
  24 * 60 * 60 * 1000,
)

await app.listen({ port: config.PORT, host: '0.0.0.0' })
