import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import Database from 'better-sqlite3'
import { getLoadablePath } from 'sqlite-vec'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import log from 'electron-log/main'
import * as schema from './knowledgeSchema'
import { defaultDataDir, readBootConfig } from '../lib/config'

export type DB = BetterSQLite3Database<typeof schema>

let sqlite: Database.Database | null = null
let db: DB | null = null
let resolvedDataDir: string | null = null

/** 数据根目录：数据库、素材、备份都在这里 */
export function dataDir(): string {
  if (!resolvedDataDir) resolvedDataDir = readBootConfig().dataDir || defaultDataDir()
  return resolvedDataDir
}

export const dbPath = (): string => join(dataDir(), 'jiwei.db')
export const assetsDir = (): string => join(dataDir(), 'assets')
export const backupsDir = (): string => join(dataDir(), 'backups')

function migrationsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'migrations') : join(app.getAppPath(), 'resources/migrations')
}

/** 是否存在尚未执行的迁移（用于迁移前备份） */
function hasPendingMigrations(conn: Database.Database): boolean {
  const journal = JSON.parse(readFileSync(join(migrationsDir(), 'meta/_journal.json'), 'utf8')) as { entries: unknown[] }
  const exists = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'").get()
  if (!exists) return false
  const { n } = conn.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number }
  return n < journal.entries.length
}

export async function openDatabase(): Promise<DB> {
  if (db) return db
  for (const d of [dataDir(), assetsDir(), backupsDir()]) mkdirSync(d, { recursive: true })
  const isNew = !existsSync(dbPath())
  sqlite = new Database(dbPath())
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  // 向量检索扩展；安装包中原生文件位于 app.asar.unpacked
  sqlite.loadExtension(getLoadablePath().replace('app.asar', 'app.asar.unpacked'))

  if (!isNew && hasPendingMigrations(sqlite)) {
    const target = join(backupsDir(), `pre-migrate-${Date.now()}.db`)
    log.info('[db] pending migrations, backing up to', target)
    await sqlite.backup(target)
  }

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
  if (!sqlite) return
  try {
    sqlite.pragma('wal_checkpoint(TRUNCATE)')
  } catch {
    /* 数据库可能已关闭 */
  }
  sqlite.close()
  sqlite = null
  db = null
}
