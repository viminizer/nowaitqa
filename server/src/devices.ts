import type { DeviceBody, DeviceContactBody } from '@nowait/shared'
import { and, eq, ne, or, sql } from 'drizzle-orm'
import { type DbTransaction, db } from './db/index.ts'
import { devices, queue, setupJobs } from './db/schema.ts'

export class BadDeviceError extends Error {}

// All registration/setup port decisions on a host share this lock, including manual adds.
export async function lockDeviceHost(tx: DbTransaction, host: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${host}, 40))`)
}

export async function deviceBusy(tx: DbTransaction, name: string) {
  return (
    (
      await tx
        .select({ id: queue.id })
        .from(queue)
        .where(
          and(
            eq(queue.device, name),
            or(eq(queue.status, 'leased'), eq(queue.cleanupPending, true)),
          ),
        )
        .limit(1)
    ).length > 0
  )
}

export async function setupHoldsDevice(tx: DbTransaction, name: string) {
  const [held] = await tx
    .select({ id: setupJobs.id })
    .from(setupJobs)
    .where(
      and(eq(setupJobs.deviceName, name), sql`${setupJobs.status} IN ('active','interrupted')`),
    )
    .limit(1)
  return !!held
}

export async function checkDevicePorts(
  tx: DbTransaction,
  host: string,
  port: number,
  platform: 'android' | 'ios',
  name?: string,
  setupId?: number,
) {
  const end = port + (platform === 'ios' ? 1 : 0)
  const [phone] = await tx
    .select({ name: devices.name })
    .from(devices)
    .where(
      and(
        eq(devices.host, host),
        name ? ne(devices.name, name) : undefined,
        sql`${devices.systemPort} <= ${end} AND ${devices.systemPort} + CASE WHEN ${devices.platform} = 'ios' THEN 1 ELSE 0 END >= ${port}`,
      ),
    )
    .limit(1)
  const [reserved] = await tx
    .select({ id: setupJobs.id })
    .from(setupJobs)
    .where(
      and(
        eq(setupJobs.host, host),
        setupId ? ne(setupJobs.id, setupId) : undefined,
        sql`${setupJobs.status} IN ('active','interrupted') AND ${setupJobs.reservedPort} <= ${end} AND ${setupJobs.reservedPort} + CASE WHEN ${setupJobs.target}->>'platform' = 'ios' THEN 1 ELSE 0 END >= ${port}`,
      ),
    )
    .limit(1)
  if (phone || reserved)
    throw new BadDeviceError('port is already registered or reserved on this machine')
}

// The caller's transaction also owns setup completion; no registration may race a reservation.
export async function registerDeviceIn(
  tx: DbTransaction,
  body: DeviceBody,
  mode: 'create' | 'upsert',
  setupId?: number,
) {
  await lockDeviceHost(tx, body.host)
  const [old] = await tx
    .select()
    .from(devices)
    .where(eq(devices.name, body.name))
    .for('no key update')
  if (old && mode === 'create')
    throw new BadDeviceError(`a phone named ${body.name} already exists`)
  const changed =
    old &&
    (old.host !== body.host ||
      old.udid !== body.udid ||
      old.platform !== body.platform ||
      old.appiumUrl !== body.appiumUrl ||
      old.systemPort !== body.systemPort ||
      (body.platformVersion !== undefined && old.platformVersion !== body.platformVersion))
  const [held] = await tx
    .select({ id: setupJobs.id })
    .from(setupJobs)
    .where(
      and(
        setupId ? ne(setupJobs.id, setupId) : undefined,
        sql`${setupJobs.status} IN ('active','interrupted')`,
        or(
          eq(setupJobs.deviceName, body.name),
          and(eq(setupJobs.host, body.host), eq(setupJobs.reservedUdid, body.udid)),
        ),
      ),
    )
    .limit(1)
  if (held || (changed && (await deviceBusy(tx, body.name))))
    throw new BadDeviceError('device has active work or a setup/cleanup reservation')
  if (!old || changed)
    await checkDevicePorts(tx, body.host, body.systemPort, body.platform, old?.name, setupId)
  const insert = tx.insert(devices).values(body)
  const [device] = await (mode === 'upsert'
    ? insert.onConflictDoUpdate({
        target: devices.name,
        set: {
          ...body,
          virtualKey: sql`CASE WHEN ${devices.host} = excluded.host AND ${devices.udid} = excluded.udid AND ${devices.platform} = excluded.platform THEN ${devices.virtualKey} ELSE NULL END`,
          lastSeenAt: sql`CASE WHEN ${devices.host} = excluded.host AND ${devices.udid} = excluded.udid AND ${devices.platform} = excluded.platform THEN ${devices.lastSeenAt} ELSE NULL END`,
        },
      })
    : insert
  ).returning()
  if (!device) throw new Error('registration returned no device')
  return device
}

export async function registerDevice(body: DeviceBody, mode: 'create' | 'upsert') {
  try {
    return await db.transaction((tx) => registerDeviceIn(tx, body, mode))
  } catch (err) {
    const pg = (err as { cause?: { code?: string; constraint?: string } }).cause
    if (pg?.code === '23505') {
      if (pg.constraint === 'devices_host_udid_idx' || pg.constraint === 'devices_udid_unique')
        throw new BadDeviceError('device ID already belongs to a registration on this machine')
      if (pg.constraint === 'devices_pkey')
        throw new BadDeviceError(`a phone named ${body.name} already exists`)
      if (pg.constraint === 'devices_virtual_target_idx')
        throw new BadDeviceError('virtual device already has a registration on this machine')
    }
    throw err
  }
}

export async function noteDeviceContact(body: DeviceContactBody) {
  const [device] = await db
    .update(devices)
    .set({ lastSeenAt: sql`now()` })
    .where(
      and(
        eq(devices.name, body.name),
        eq(devices.host, body.host),
        eq(devices.udid, body.udid),
        eq(devices.platform, body.platform),
      ),
    )
    .returning({ name: devices.name })
  return device !== undefined
}
