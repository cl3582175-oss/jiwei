import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getLoadablePath } from 'sqlite-vec'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const f = vi.hoisted(() => ({
  sql: null as Database.Database | null,
  db: null as ReturnType<typeof drizzle> | null,
  ready: false,
  mode: 'local',
  calls: 0
}))
vi.mock('../../../db', () => ({ getDb: () => f.db, getSqlite: () => f.sql }))
vi.mock('../../../events', () => ({ emit: () => {}, onMainEvent: () => () => {} }))
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {} } }))
vi.mock('../../settings', () => ({ getSettings: () => ({ ai: { embedding: { mode: f.mode } } }) }))
vi.mock('../../jobs', () => ({ enqueue: () => {}, registerJobKind: () => {} }))
vi.mock('../embedding', () => ({
  isReady: async () => f.ready,
  currentModelId: () => 'controlled',
  setStatus: () => {},
  embed: async (texts: string[]) => {
    f.calls++
    return texts.map(() => [1, ...Array(511).fill(0)])
  }
}))
import { retrieve } from '../retrieve'
import { replaceSegments, listSegments } from '../../segments'
import { vecBuffer } from '../indexer'

beforeEach(() => {
  f.ready = false
  f.mode = 'local'
  f.calls = 0
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
function source(id: string, opts: { title?: string; space?: string; excluded?: number; deleted?: number } = {}) {
  f.sql!.prepare(
    'INSERT INTO sources(id,title,kind,space,ai_excluded,deleted_at,accessed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1,1)'
  ).run(id, opts.title ?? `合成${id}`, 'document', opts.space ?? 'library', opts.excluded ?? 0, opts.deleted ?? null)
}
function segments(id: string, texts: string[], heading = '') {
  replaceSegments(
    id,
    texts.map((text) => ({ text, heading, kind: 'paragraph', locator: {} }))
  )
  return listSegments(id)
}
function vector(ownerId: string, parentId: string, x = 1, y = 0) {
  const r = f
    .sql!.prepare(
      "INSERT INTO chunks(owner_type,owner_id,parent_type,parent_id,hash,model,created_at) VALUES('segment',?,'source',?,'hash','controlled',1) RETURNING rowid"
    )
    .get(ownerId, parentId) as { rowid: number }
  f.sql!.prepare('INSERT INTO vec_chunks(rowid,embedding) VALUES(?,?)').run(BigInt(r.rowid), vecBuffer([x, y, ...Array(510).fill(0)]))
}

describe('生产检索的范围、隐私和独立候选预算', () => {
  it('关键词在范围内取候选，范围外的更强匹配不能挤走目标', async () => {
    source('outside')
    source('target')
    segments('outside', Array(100).fill('合成稀有条件'))
    const target = segments('target', ['合成稀有条件，目标资料还带有长一些的独立说明。'])[0]
    const hits = await retrieve('合成稀有条件', { type: 'items', notes: [], sources: ['target'] }, 8)
    expect(hits.map((h) => h.ownerId)).toEqual([target.id])
  })
  it('向量在范围内精确计算，外部100个更相似片段不遮住目标', async () => {
    f.ready = true
    source('outside')
    source('target')
    for (const s of segments(
      'outside',
      Array.from({ length: 100 }, (_, i) => `完全无关的独立资料第${i}条。`)
    ))
      vector(s.id, 'outside')
    const target = segments('target', ['目标资料没有字面重合，但是语义上相关。'])[0]
    vector(target.id, 'target', 0.8, 0.6)
    const hits = await retrieve('语义探针', { type: 'items', notes: [], sources: ['target'] }, 8)
    expect(hits.map((h) => h.ownerId)).toEqual([target.id])
    expect(hits[0].sim).toBeCloseTo(0.8)
  })
  it('所有候选入口先排除隐私/删除/附件，allow仅开放附件而不覆盖库内开关', async () => {
    source('private', { excluded: 1 })
    source('deleted', { deleted: 1 })
    source('attachment', { space: 'attachment', excluded: 0 })
    source('public')
    segments('private', Array(50).fill('隔离合成条件PRIVATE-MARKER'))
    segments('deleted', ['隔离合成条件DELETED-MARKER'])
    segments('attachment', ['隔离合成条件ATTACHMENT-MARKER'])
    segments('public', ['隔离合成条件公开且可核查。'])
    const hits = await retrieve('隔离合成条件', { type: 'all' }, 8)
    expect(hits.map((h) => h.parentId)).toEqual(['public'])
    const allowed = await retrieve('隔离合成条件', { type: 'all' }, 8, {}, null, { sourceIds: ['private', 'attachment'] })
    expect(allowed.some((h) => h.parentId === 'attachment')).toBe(true)
    expect(allowed.some((h) => ['private', 'deleted'].includes(h.parentId))).toBe(false)
  })
  it('两字词能匹配正文和路径，按命中词频排序', async () => {
    source('many')
    source('one')
    source('heading')
    segments('many', ['节拍节拍节拍的合成验收条件。'])
    segments('one', ['节拍的另一项条件。'])
    segments('heading', ['只有标题包含这个关键词。'], '第一章节拍')
    const hits = await retrieve('节拍', { type: 'all' }, 8)
    expect(hits[0].parentId).toBe('many')
    expect(new Set(hits.map((h) => h.parentId))).toEqual(new Set(['many', 'one', 'heading']))
    expect(hits.find((h) => h.parentId === 'heading')?.heading).toBe('第一章节拍')
  })
  it('精确编号独立一路能优先于没有该编号的向量近似资料', async () => {
    f.ready = true
    source('exact')
    source('similar')
    const exact = segments('exact', ['设备ZK-9911的合成验收条件为证据完整。'])[0]
    for (const s of segments('similar', ['设备相近条件的合成说明，未包含目标编号。'])) vector(s.id, 'similar')
    expect((await retrieve('“ZK-9911”', { type: 'all' }, 8))[0].ownerId).toBe(exact.id)
  })
  it('云端向量不接收带私有附件的检索文本', async () => {
    f.ready = true
    f.mode = 'cloud'
    source('attachment', { space: 'attachment', excluded: 1 })
    segments('attachment', ['隔离合成条件ATTACHMENT-MARKER'])
    expect(await retrieve('隔离合成条件', { type: 'all' }, 8, {}, null, { sourceIds: ['attachment'] })).toHaveLength(1)
    expect(f.calls).toBe(0)
  })
})
describe('证据选择与可核对的上下文', () => {
  it('重复原文只保留一条并记录另见标题', async () => {
    source('a', { title: '合成资料甲' })
    source('b', { title: '合成资料乙' })
    const text = '合成检验要以可核对证据为依据，重复来源应合并显示。'
    segments('a', [text])
    segments('b', [text])
    const hits = await retrieve('合成检验', { type: 'all' }, 8)
    expect(hits).toHaveLength(1)
    expect(hits[0].alsoIn).toEqual(['合成资料乙'])
  })
  it('全局结果每份资料最多三条，显式范围仍可读取更多', async () => {
    source('a')
    source('b')
    const descriptions = [
      '青色金属的抗弯强度',
      '黄色陶瓷的热稳定性',
      '红色木料的切割位置',
      '蓝色玻璃的透光结果',
      '绿色塑料的耐水能力',
      '白色纸张的厚度判断'
    ]
    segments(
      'a',
      descriptions.map((x) => '合成检验：' + x + '。')
    )
    segments(
      'b',
      descriptions.slice(0, 4).map((x) => '合成检验：独立复核' + x + '与签字要求。')
    )
    const hits = await retrieve('合成检验', { type: 'all' }, 8)
    expect(hits.filter((h) => h.parentId === 'a')).toHaveLength(3)
    expect(hits.filter((h) => h.parentId === 'b')).toHaveLength(3)
    expect(await retrieve('合成检验', { type: 'items', notes: [], sources: ['a'] }, 8)).toHaveLength(6)
  })
  it('短段只展开同资料同路径下一段，保持原ownerId', async () => {
    source('a')
    source('private', { excluded: 1 })
    const parts = segments('a', ['设备采用周期检验。', '相邻段补全了重要背景。'], '第一章')
    segments('private', ['PRIVATE-NEIGHBOR-MARKER'], '第一章')
    const hits = await retrieve('设备采用周期', { type: 'items', notes: [], sources: ['a'] }, 8)
    expect(hits[0].ownerId).toBe(parts[0].id)
    expect(hits[0].text).toBe('设备采用周期检验。\n…\n相邻段补全了重要背景。')
  })
})

it('an attachment Word table keeps its body and neighbor expansion cannot reveal spreadsheet rows beyond200', async () => {
  source('attachment', { space: 'attachment' })
  replaceSegments('attachment', [
    {
      kind: 'table',
      locator: { value: 'block=1' },
      text: '| Name | Value |\n| --- | --- |\n| first | 1 |\n| second | 2 |\n| SYNTHETIC-WORD-BODY | 5 |'
    },
    { kind: 'paragraph', locator: {}, text: 'Synthetic neighbor probe' },
    { kind: 'table', locator: { dataStart: 200, totalRows: 201 }, text: 'Table\n| name |\n| --- |\n| ROW201-PRIVATE |' }
  ])
  const word = await retrieve('SYNTHETIC-WORD-BODY', { type: 'all' }, 8, {}, null, { sourceIds: ['attachment'] })
  expect(word[0]?.text).toContain('SYNTHETIC-WORD-BODY')
  const neighbor = await retrieve('Synthetic neighbor probe', { type: 'all' }, 8, {}, null, { sourceIds: ['attachment'] })
  expect(neighbor[0]?.text).not.toContain('ROW201-PRIVATE')
})
it('scope batches over500 preserve hits from both ends', async () => {
  const ids = Array.from({ length: 502 }, (_, i) => 'batch' + i)
  for (const id of ids) source(id)
  segments(ids[0], ['合成分批查询甲条件。'])
  segments(ids[501], ['合成分批查询乙条件。'])
  const hits = await retrieve('合成分批查询', { type: 'items', notes: [], sources: ids }, 8)
  expect(new Set(hits.map((h) => h.parentId))).toEqual(new Set([ids[0], ids[501]]))
})

it('over20000 scoped segments uses400 global candidates even when most segments have not been indexed', async () => {
  f.ready = true
  source('large')
  source('outside')
  f.sql!.exec(`WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<20000)
    INSERT INTO source_segments(id,source_id,ordinal,kind,text,hash,locator,created_at,updated_at)
    SELECT 'large-'||i,'large',i,'paragraph','Synthetic large scope item '||i,'h'||i,'{}',1,1 FROM n`)
  vector('large-0', 'large', 0.8, 0.6)
  for (const s of segments(
    'outside',
    Array.from({ length: 401 }, (_, i) => 'Different public semantic item ' + i)
  ))
    vector(s.id, 'outside')
  expect(await retrieve('完全无字面对应探针', { type: 'items', notes: [], sources: ['large'] }, 8)).toEqual([])
})

it('structured Word table previews count200 data rows across chunks on the same original block', async () => {
  source('word', { space: 'attachment' })
  replaceSegments('word', [
    {
      kind: 'table',
      locator: { value: 'block=1' },
      text: '| Key |\n| --- |\n' + Array.from({ length: 100 }, (_, i) => '| A' + i + ' |').join('\n')
    },
    {
      kind: 'table',
      locator: { value: 'block=1' },
      text: '| Key |\n| --- |\n' + Array.from({ length: 100 }, (_, i) => '| B' + i + ' |').join('\n')
    },
    { kind: 'table', locator: { value: 'block=1' }, text: '| Key |\n| --- |\n| WORD-ROW201-PRIVATE |' }
  ])
  const hits = await retrieve('WORD-ROW201-PRIVATE', { type: 'all' }, 8, {}, null, { sourceIds: ['word'] })
  expect(hits).toEqual([])
})
