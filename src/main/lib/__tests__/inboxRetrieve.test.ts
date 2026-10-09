import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db', () => ({ getDb: vi.fn(), getSqlite: vi.fn() }))
vi.mock('../../services/ai/embedding', () => ({ embed: vi.fn(), isReady: vi.fn() }))
vi.mock('../../services/ai/indexer', () => ({ annotationText: vi.fn(), vecBuffer: vi.fn() }))
import { CORNELL_SIMILARITY_SQL } from '../../services/ai/retrieve'

// 使用与应用相同的 Electron ABI、真实 SQLite 和 sqlite-vec 验证查询；不调用模型或用户数据库。
function runQuery(): { rowid: number; distance: number; parent: string }[] {
  const electronPath = createRequire(import.meta.url)('electron') as string
  const script = `
    const Database = require('better-sqlite3')
    const db = new Database(':memory:')
    db.loadExtension(require('sqlite-vec').getLoadablePath())
    db.exec(\`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[2] distance_metric=cosine);
      CREATE TABLE chunks(rowid INTEGER PRIMARY KEY, parent_type TEXT, parent_id TEXT, owner_type TEXT, owner_id TEXT);
      CREATE TABLE notes(id TEXT PRIMARY KEY, kind TEXT, deleted_at INTEGER, ai_excluded INTEGER);
      CREATE TABLE blocks(id TEXT PRIMARY KEY, deleted_at INTEGER);
      CREATE TABLE note_asset_blocks(id TEXT, asset_id TEXT);
      CREATE TABLE asset_texts(asset_id TEXT);
      CREATE TABLE annotations(id TEXT, deleted_at INTEGER, body TEXT);\`)
    let seq = 0
    const insert = (parent, distance, type = 'note', kind = 'cornell', excluded = 0, deleted = null, stale = false) => {
      db.prepare('INSERT OR IGNORE INTO notes VALUES (?,?,?,?)').run(parent, kind, deleted, excluded)
      const id = ++seq
      db.prepare('INSERT INTO chunks VALUES (?,?,?,?,?)').run(id, type, parent, 'block', 'block-' + id)
      db.prepare('INSERT INTO blocks VALUES (?,?)').run('block-' + id, stale ? 1 : null)
      const cosine = 1 - distance
      const vector = Buffer.from(new Float32Array([cosine, Math.sqrt(1 - cosine * cosine)]).buffer)
      db.prepare('INSERT INTO vec_chunks(rowid,embedding) VALUES (?,?)').run(BigInt(id), vector)
    }
    // 这些片段全部比合法笔记更近，足以填满旧查询的 48 个名额。
    for (let i = 0; i < 60; i++) insert('source-' + i, 0.01, 'source')
    insert('free-1', 0.02, 'note', 'freeform'); insert('free-2', 0.02, 'note', 'freeform')
    insert('excluded', 0.03, 'note', 'cornell', 1); insert('deleted', 0.03, 'note', 'cornell', 0, 1)
    insert('stale', 0.04, 'note', 'cornell', 0, null, true)
    for (let i = 0; i < 60; i++) insert('valid-1', 0.1 + i / 1000)
    insert('valid-2', 0.3); insert('valid-3', 0.4); insert('too-distant', 0.95)
    const rows = db.prepare(${JSON.stringify(CORNELL_SIMILARITY_SQL)}).all(Buffer.from(new Float32Array([1, 0]).buffer), 0.8, 3)
    process.stdout.write(JSON.stringify(rows.map(row => ({ ...row, parent: db.prepare('SELECT parent_id FROM chunks WHERE rowid = ?').get(row.rowid).parent_id }))))
    db.close()
  `
  return JSON.parse(execFileSync(electronPath, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }))
}
describe('distinct Cornell vector candidates', () => {
  it('retrieves three eligible notes despite closer sources, invalid notes and repeated fragments', () => {
    const rows = runQuery()
    expect(rows.map((r) => r.parent)).toEqual(['valid-1', 'valid-2', 'valid-3'])
    expect(rows[0].distance).toBeCloseTo(0.1)
    expect(rows[1].distance).toBeCloseTo(0.3)
    expect(rows[2].distance).toBeCloseTo(0.4)
  })
})
