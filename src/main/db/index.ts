import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema'

export type DB = BetterSQLite3Database<typeof schema>

let sqlite: Database.Database | null = null
let db: DB | null = null

/** 应用数据根目录：数据库、资料文件、备份都在这里 */
export function dataDir(): string {
  return join(app.getPath('userData'), 'data')
}

export function libraryDir(): string {
  return join(dataDir(), 'library')
}

function migrationsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'migrations') : join(app.getAppPath(), 'resources/migrations')
}

export function openDatabase(): DB {
  if (db) return db
  mkdirSync(libraryDir(), { recursive: true })
  sqlite = new Database(join(dataDir(), 'jiwei.db'))
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: migrationsDir() })
  return db
}

export function getDb(): DB {
  if (!db) throw new Error('Database not opened')
  return db
}

export function getSqlite(): Database.Database {
  if (!sqlite) throw new Error('Database not opened')
  return sqlite
}

export function closeDatabase(): void {
  sqlite?.close()
  sqlite = null
  db = null
}
