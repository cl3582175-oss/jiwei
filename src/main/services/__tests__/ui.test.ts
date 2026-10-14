import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { samples } from '@shared/ui/__tests__/fixtures'
import { getLoadablePath } from 'sqlite-vec'

const fixture = vi.hoisted(() => ({ db: null as ReturnType<typeof drizzle> | null, sqlite: null as Database.Database | null }))
vi.mock('../../db', () => ({ getDb: () => fixture.db, getSqlite: () => fixture.sqlite }))
vi.mock('electron', () => ({ app: { getLocale: () => 'zh-CN', isPackaged: false }, nativeTheme: { themeSource: 'system' } }))
vi.mock('../../events', () => ({ emit: () => undefined }))
vi.mock('../device', () => ({ deviceId: () => 'test-device' }))
// 断开非本测试所有的浏览器/工作线程生命周期；笔记、提案与数据库映射使用真实实现。
vi.mock('../browser/manager', () => ({ browserState: () => ({ tabs: [] }) }))
import { states, saveState, saveToNote } from '../ui'
import { getSegment } from '../segments'

beforeEach(() => {
  fixture.sqlite = new Database(':memory:')
  fixture.sqlite.loadExtension(getLoadablePath())
  const folder = join(process.cwd(), 'resources', 'migrations')
  for (const file of readdirSync(folder)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    fixture.sqlite.exec(readFileSync(join(folder, file), 'utf8'))
  fixture.db = drizzle(fixture.sqlite)
  fixture.sqlite.exec(
    `INSERT INTO conversations (id,title,scope,created_at,updated_at) VALUES ('c','对话','{"type":"none"}',1,1); INSERT INTO messages (id,conversation_id,role,created_at,updated_at) VALUES ('m','c','assistant',1,1); INSERT INTO notes (id,title,learned_at,created_at,updated_at,edited_at) VALUES ('n','目标笔记',1,1,1,1)`
  )
})
afterEach(() => fixture.sqlite?.close())
it('组件片段读取拒绝不给 AI、删除或仅本地录音的原文', () => {
  fixture.sqlite!.exec(
    "INSERT INTO sources (id,title,kind,accessed_at,created_at,updated_at) VALUES ('src','原始资料','document',1,1,1); INSERT INTO source_segments (id,source_id,ordinal,kind,locator,text,hash,created_at,updated_at) VALUES ('seg','src',0,'text','{}','真实原文','test-content-hash',1,1)"
  )
  expect(getSegment('seg')?.text).toBe('真实原文')
  fixture.sqlite!.exec("UPDATE sources SET ai_excluded=1 WHERE id='src'")
  expect(getSegment('seg')).toBeNull()
  fixture.sqlite!.exec("UPDATE recordings SET local_only=0;UPDATE sources SET deleted_at=1 WHERE id='src'")
  expect(getSegment('seg')).toBeNull()
  fixture.sqlite!.exec(
    "UPDATE sources SET ai_excluded=0,deleted_at=NULL WHERE id='src'; INSERT INTO recordings (id,source_id,scene,status,tracks,started_at,local_only,created_at,updated_at) VALUES ('recording','src','meeting','ready','[]',1,1,1,1)"
  )
  expect(getSegment('seg')).toBeNull()
})
it('按回答及组件保存和覆盖，未出现的回答与用户消息不能写状态', () => {
  saveState('m', 'b0', { checked: [true] })
  saveState('m', 'b1', { tab: 1 })
  saveState('m', 'b0', { checked: [false] })
  expect(states('m')).toEqual({ b0: { checked: [false] }, b1: { tab: 1 } })
  expect(() => saveState('missing', 'b0', {})).toThrow()
  fixture.sqlite!.exec("UPDATE messages SET role='user' WHERE id='m'")
  expect(() => saveState('m', 'b0', {})).toThrow()
})
it('16 KiB 上限按字节计，无痕不读写状态', () => {
  saveState('m', 'b0', { value: '中'.repeat(6000) })
  expect(states('m')).toEqual({})
  saveState('m', 'b0', { value: 1 })
  fixture.sqlite!.exec("UPDATE conversations SET incognito=1 WHERE id='c'")
  saveState('m', 'b1', { value: 2 })
  expect(states('m')).toEqual({})
  expect(fixture.sqlite!.prepare('SELECT COUNT(*) AS n FROM ui_states').get()).toEqual({ n: 1 })
})
for (const [type, node] of Object.entries(samples))
  it(`${type} 存入现有笔记的提案映射`, () => {
    const result = saveToNote({
      conversationId: 'c',
      messageId: 'm',
      uiKey: 'b0',
      node,
      target: { noteId: 'n' },
      mode: type === 'quiz' ? 'rows' : 'auto'
    })
    expect(result.created).toBe(false)
    const row = fixture.sqlite!.prepare('SELECT ops FROM proposals WHERE id=?').get(result.proposalId) as { ops: string }
    const payload = JSON.parse(row.ops)
    expect(payload.auto).toBe(true)
    const visualKinds: Record<string, string> = { chart: 'chart', diagram: 'diagram', timeline: 'timeline', codesteps: 'steps' }
    if (visualKinds[type]) expect(Object.values(payload.embeds)).toEqual([expect.objectContaining({ kind: visualKinds[type] })])
    else if (['quiz', 'flashcards', 'cloze'].includes(type)) {
      expect(payload.ops[0].op).toBe('insert_row')
      expect(payload.ops[0].cue.length).toBeGreaterThan(0)
    } else
      expect(Object.values(payload.embeds)).toEqual([
        expect.objectContaining({
          kind: 'ui',
          data: expect.objectContaining({ savedAt: expect.any(Number), node: expect.objectContaining({ type }) })
        })
      ])
  })
it('映射保留真实图表类型、练习正确答案与出处；不合格写入没有创建笔记', () => {
  const r = saveToNote({ conversationId: 'c', messageId: 'm', uiKey: 'b0', node: samples.chart, target: { noteId: 'n' }, mode: 'auto' })
  const payload = JSON.parse((fixture.sqlite!.prepare('SELECT ops FROM proposals WHERE id=?').get(r.proposalId) as { ops: string }).ops)
  expect(payload.embeds.v.data.type).toBe('bar')
  expect(payload.embeds.v.data.kind).toBeUndefined()
  expect(() =>
    saveToNote({ conversationId: 'wrong', messageId: 'm', uiKey: 'b0', node: samples.list, target: { newTitle: '不应创建' }, mode: 'auto' })
  ).toThrow()
  expect((fixture.sqlite!.prepare('SELECT COUNT(*) AS n FROM notes').get() as { n: number }).n).toBe(1)
})
it('不能追加到软删除笔记，也不能写入被删除对话的状态', () => {
  fixture.sqlite!.exec("UPDATE notes SET deleted_at=1 WHERE id='n'")
  expect(() =>
    saveToNote({ conversationId: 'c', messageId: 'm', uiKey: 'b0', node: samples.list, target: { noteId: 'n' }, mode: 'auto' })
  ).toThrow()
  expect(fixture.sqlite!.prepare('SELECT COUNT(*) AS n FROM proposals').get()).toEqual({ n: 0 })
  fixture.sqlite!.exec("UPDATE conversations SET deleted_at=1 WHERE id='c'")
  expect(() => saveState('m', 'b0', {})).toThrow()
})
