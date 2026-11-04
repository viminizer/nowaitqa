import type { DeviceBody, DeviceContactBody } from '@nowait/shared'
import { and, eq, sql } from 'drizzle-orm'
import { db } from './db/index.ts'
import { devices } from './db/schema.ts'

export class BadDeviceError extends Error {}

// The dashboard only adds; PUT /devices can also update an existing registration.
export async function registerDevice(body: DeviceBody, mode: 'create' | 'upsert') {
  try {
    const insert = db.insert(devices).values(body)
    const [device] = await (mode === 'upsert'
      ? insert.onConflictDoUpdate({
          target: devices.name,
          set: {
            ...body,
            lastSeenAt: sql`case when ${devices.host} = excluded.host
              and ${devices.udid} = excluded.udid and ${devices.platform} = excluded.platform
              then ${devices.lastSeenAt} else null end`,
          },
        })
      : insert
    ).returning()
    return device
  } catch (err) {
    // Drizzle wraps the Postgres error; 23505 = unique value already taken.
    const pg = (err as { cause?: { code?: string; constraint?: string } }).cause
    if (pg?.code === '23505') {
      if (pg.constraint === 'devices_udid_unique') {
        throw new BadDeviceError(`udid ${body.udid} already belongs to another phone`)
      }
      if (pg.constraint === 'devices_pkey') {
        throw new BadDeviceError(`a phone named ${body.name} already exists`)
      }
    }
    throw err
  }
}

// An identity change must not let an old worker keep the replacement registration online.
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
