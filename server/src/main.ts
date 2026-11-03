import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { deleteOldArtifacts } from './artifacts.ts'
import { config } from './config.ts'
import { runMigrations } from './db/index.ts'
import { startNotifications } from './notify/index.ts'
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
  const route = req.routeOptions.url // the matched route; undefined when nothing matches
  if (route === '/health') return
  const given = req.headers.authorization ?? ''
  // The browser can't send a Bearer token on a link, so the dashboard uses basic auth instead.
  // Decided by the matched route, not the raw URL (/%64ashboard matches the same route). An unknown
  // /dashboard URL still asks for the password, then answers 404.
  if ((route ?? req.url).startsWith('/dashboard')) {
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
  if (!TRIGGER_ROUTES.includes(route ?? '')) {
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

// First, so a run that the jobs below finish is news to a platform turned on just now.
await startNotifications(app.log)

// Background jobs: each runs once now and then `ms` after it ends, so a restart can't skip a long
// timer (R48) and a slow run never overlaps the next. A failing job is retried on the next tick,
// and logs its first 3 failures in a row, then every 100th (R49).
const every = (ms: number, name: string, job: () => Promise<unknown>) => {
  let failures = 0
  const run = async () => {
    try {
      await job()
      failures = 0
    } catch (err) {
      failures++
      if (failures <= 3 || failures % 100 === 0) {
        app.log.error(err, `${name} failed (${failures} in a row)`)
      }
    }
    setTimeout(run, ms)
  }
  run()
}
// the expiry jobs wait at first on their own, to give runners time to come back (see queue.ts)
every(15_000, 'expireLeases', expireLeases)
every(60_000, 'expireRuns', expireRuns)
every(24 * 60 * 60 * 1000, 'deleteOldArtifacts', deleteOldArtifacts)

await app.listen({ port: config.PORT, host: '0.0.0.0' })
