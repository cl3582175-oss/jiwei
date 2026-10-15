import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import log from 'electron-log/main'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './personalSchema'

// 个人数据库：记忆属于“人”，不属于某个知识库。
// 位于应用用户目录（不随知识库切换、迁移、共享），切换知识库后仍然“认识你”。
// 保留历史记忆 user_version 迁移；新声纹表使用从 schema.ts 生成的 Drizzle 迁移。

let conn: Database.Database | null = null
let typed: BetterSQLite3Database<typeof schema> | null = null

const MIGRATIONS: string[] = [
  // 1：记忆
  `CREATE TABLE memories (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     key TEXT,
     skill TEXT,
     content TEXT NOT NULL,
     sensitive INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'active',
     pinned INTEGER NOT NULL DEFAULT 0,
     confidence REAL NOT NULL DEFAULT 1,
     origin TEXT NOT NULL,
     evidence TEXT,
     valid_from INTEGER NOT NULL,
     invalid_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     last_used_at INTEGER,
     use_count INTEGER NOT NULL DEFAULT 0
   );
   CREATE UNIQUE INDEX memories_kind_key ON memories(kind, key) WHERE key IS NOT NULL;
   CREATE INDEX memories_status ON memories(status, kind);
   CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='rowid', tokenize='trigram');
   CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
     INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
   END;
   CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
     INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
   END;
   CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
     INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
     INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
   END;`,
  // 2：记忆 v2——学习者模型（概念掌握度与信号）、技能反馈样本、对话整理进度、个人设置
  `CREATE TABLE concepts (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     norm TEXT NOT NULL UNIQUE,
     mastery REAL NOT NULL,
     asked INTEGER NOT NULL DEFAULT 0,
     confused INTEGER NOT NULL DEFAULT 0,
     understood INTEGER NOT NULL DEFAULT 0,
     note TEXT,
     first_seen INTEGER NOT NULL,
     last_seen INTEGER NOT NULL
   );
   CREATE TABLE concept_events (
     id TEXT PRIMARY KEY,
     concept_id TEXT NOT NULL,
     type TEXT NOT NULL,
     at INTEGER NOT NULL,
     evidence TEXT
   );
   CREATE INDEX concept_events_concept ON concept_events(concept_id, at);
   CREATE TABLE skill_feedback (
     id TEXT PRIMARY KEY,
     skill TEXT NOT NULL,
     kind TEXT NOT NULL,
     note_id TEXT,
     block_ids TEXT,
     before TEXT NOT NULL,
     after TEXT,
     created_at INTEGER NOT NULL,
     checked_at INTEGER,
     consumed_at INTEGER
   );
   CREATE INDEX skill_feedback_kind ON skill_feedback(kind, skill);
   CREATE TABLE extract_state (
     conversation_id TEXT PRIMARY KEY,
     last_message_at INTEGER NOT NULL
   );
   CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // 3：仅限项目的记忆与技能反馈；NULL 仍表示原有的全局记忆。
  `ALTER TABLE memories ADD project_id TEXT;
   CREATE INDEX memories_project ON memories(project_id);
   DROP INDEX memories_kind_key;
   CREATE UNIQUE INDEX memories_kind_key_global ON memories(kind, key) WHERE key IS NOT NULL AND project_id IS NULL;
   CREATE UNIQUE INDEX memories_kind_key_project ON memories(project_id, kind, key) WHERE key IS NOT NULL AND project_id IS NOT NULL;
   ALTER TABLE skill_feedback ADD project_id TEXT;
   CREATE INDEX skill_feedback_project ON skill_feedback(project_id, kind, skill);`
]

export const profileDbPath = (): string => join(app.getPath('userData'), 'profile', 'memory.db')

export function profileDb(): Database.Database {
  if (conn) return conn
  mkdirSync(join(app.getPath('userData'), 'profile'), { recursive: true })
  conn = new Database(profileDbPath())
  conn.pragma('journal_mode = WAL')
  conn.pragma('synchronous = NORMAL')
  conn.pragma('busy_timeout = 5000')
  const version = conn.pragma('user_version', { simple: true }) as number
  for (let v = version; v < MIGRATIONS.length; v++) {
    log.info('[profile] migrate to', v + 1)
    conn.transaction(() => {
      conn!.exec(MIGRATIONS[v])
      conn!.pragma(`user_version = ${v + 1}`)
    })()
  }
  try {
    typed = drizzle(conn, { schema })
    migrate(typed, {
      migrationsFolder: app.isPackaged
        ? join(process.resourcesPath, 'profile-migrations')
        : join(app.getAppPath(), 'resources/profile-migrations')
    })
  } catch (error) {
    conn.close()
    conn = null
    typed = null
    throw error
  }
  return conn
}

export function getProfileDb(): BetterSQLite3Database<typeof schema> {
  profileDb()
  return typed!
}

export function closeProfileDb(): void {
  if (!conn) return
  try {
    conn.pragma('wal_checkpoint(TRUNCATE)')
    conn.close()
  } catch {
    /* 已关闭 */
  }
  conn = null
  typed = null
}
