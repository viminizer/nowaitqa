import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { config } from '../config.ts'
import * as schema from './schema.ts'

export const db = drizzle(config.DATABASE_URL, { schema, casing: 'snake_case' })

export function runMigrations() {
  return migrate(db, { migrationsFolder: new URL('./migrations', import.meta.url).pathname })
}

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
