import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import log from 'electron-log/main'

// 个人数据库：记忆属于“人”，不属于某个知识库。
// 位于应用用户目录（不随知识库切换、迁移、共享），切换知识库后仍然“认识你”。
// 结构简单、独立演进，用 user_version 管理迁移。

let conn: Database.Database | null = null

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
   END;`
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
  return conn
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
}
