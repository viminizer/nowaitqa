import type { DeviceBody } from '@nowait/shared'
import { db } from './db/index.ts'
import { devices } from './db/schema.ts'

export class BadDeviceError extends Error {}

// The dashboard only adds; PUT /devices can also update an existing registration.
export async function registerDevice(body: DeviceBody, mode: 'create' | 'upsert') {
  try {
    const insert = db.insert(devices).values(body)
    const [device] = await (mode === 'upsert'
      ? insert.onConflictDoUpdate({ target: devices.name, set: body })
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
