import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getLoadablePath } from 'sqlite-vec'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const f = vi.hoisted(() => ({ sql: null as Database.Database | null, db: null as ReturnType<typeof drizzle> | null, invalidate: () => {} }))
vi.mock('../../../db', () => ({ getDb: () => f.db, getSqlite: () => f.sql }))
vi.mock('../../../events', () => ({
  onMainEvent: (_event: string, listener: () => void) => {
    f.invalidate = listener
    return () => {}
  }
}))
import { matchSourcesByTitle } from '../sourceMentions'
beforeEach(() => {
  f.invalidate()
  f.sql = new Database(':memory:')
  f.sql.loadExtension(getLoadablePath())
  f.db = drizzle(f.sql)
  const dir = join(process.cwd(), 'resources/migrations')
  for (const p of readdirSync(dir)
    .filter((p) => p.endsWith('.sql'))
    .sort())
    f.sql.exec(readFileSync(join(dir, p), 'utf8'))
})
afterEach(() => f.sql?.close())
function source(id: string, title: string, space = 'library', excluded = 0, deleted: number | null = null) {
  f.sql!.prepare(
    'INSERT INTO sources(id,title,kind,space,ai_excluded,deleted_at,accessed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1,1)'
  ).run(id, title, 'document', space, excluded, deleted)
}
it('通用词出现在四个标题时不误指定某一份，独有编号可定位', () => {
  for (const [i, code] of ['614', '420', '739', '851'].entries()) source(String(i), `编号${code}装配线技术协议`)
  expect(matchSourcesByTitle('装配线技术协议的验收条件', { type: 'all' })).toEqual([])
  expect(matchSourcesByTitle('614的验收条件', { type: 'all' })[0]).toMatchObject({ sourceId: '0', matched: '614', score: 3 })
})
it('日期与扩展名不干扰规范化编号，范围不越界且附件/私密/删除标题永不参与', () => {
  source('a', '2021.6.24 编号６１４测试.docx')
  source('b', '20190726 编号420测试')
  source('att', '孤立983识别探针', 'attachment', 0)
  source('private', '孤立864识别探针', 'library', 1)
  source('deleted', '孤立795识别探针', 'library', 0, 1)
  expect(matchSourcesByTitle('编号614测试', { type: 'all' })[0].sourceId).toBe('a')
  expect(matchSourcesByTitle('2021.6.24', { type: 'all' })).toEqual([])
  expect(matchSourcesByTitle('420', { type: 'items', sources: ['a'], notes: [] })).toEqual([])
  for (const code of ['983', '864', '795']) expect(matchSourcesByTitle(code, { type: 'all' })).toEqual([])
})
it('来源变化通知使标题和隐私缓存失效', () => {
  source('a', '编号614独立测试')
  expect(matchSourcesByTitle('614', { type: 'all' })).toHaveLength(1)
  f.sql!.exec("UPDATE sources SET ai_excluded=1 WHERE id='a'")
  f.invalidate()
  expect(matchSourcesByTitle('614', { type: 'all' })).toEqual([])
})
