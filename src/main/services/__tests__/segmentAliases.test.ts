import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getLoadablePath } from 'sqlite-vec'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { hashText } from '../../lib/derive'
import { EmbeddingDimensionError } from '../../lib/embeddingDimension'

const f = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sql: null as Database.Database | null,
  calls: 0,
  failAt: 0,
  inputs: [] as string[],
  status: {} as Record<string, unknown>
}))
vi.mock('../../db', () => ({ getDb: () => f.db, getSqlite: () => f.sql }))
vi.mock('../../events', () => ({ emit: () => {} }))
vi.mock('electron-log/main', () => ({ default: { info: () => {} } }))
vi.mock('../settings', () => ({ getSettings: () => ({ ai: { embedding: { mode: 'local' } } }) }))
vi.mock('../jobs', () => ({ enqueue: () => {}, registerJobKind: () => {} }))
vi.mock('../ai/embedding', () => ({
  currentModelId: () => 'controlled',
  isReady: async () => true,
  setStatus: (patch: Record<string, unknown>) => {
    f.status = { ...f.status, ...patch }
  },
  embed: async (texts: string[]) => {
    f.inputs.push(...texts)
    if (++f.calls === f.failAt) throw new EmbeddingDimensionError(768)
    return texts.map(() => [1, ...Array(511).fill(0)])
  }
}))
import * as segments from '../segments'
import { desiredChunks, syncIndex } from '../ai/indexer'

const migrationDir = join(process.cwd(), 'resources/migrations')
const sqlFiles = () =>
  readdirSync(migrationDir)
    .filter((p) => p.endsWith('.sql'))
    .sort()
const apply = (files: string[]) => files.forEach((p) => f.sql!.exec(readFileSync(join(migrationDir, p), 'utf8')))
function source() {
  f.sql!.exec("INSERT INTO sources(id,title,kind,accessed_at,created_at,updated_at) VALUES('s','合成资料','pdf',1,1,1)")
}
beforeEach(() => {
  f.sql = new Database(':memory:')
  f.sql.loadExtension(getLoadablePath())
  f.db = drizzle(f.sql)
  f.calls = 0
  f.failAt = 0
  f.inputs = []
  f.status = {}
})
afterEach(() => f.sql?.close())

describe('旧库升级与永久片段身份', () => {
  it('路径进入向量文字和哈希，旧空路径的索引哈希保持不变', async () => {
    apply(sqlFiles())
    source()
    segments.replaceSegments('s', [
      { kind: 'paragraph', text: '合成内容足够检索。', locator: {} },
      { kind: 'paragraph', heading: '合成章节', text: '中文正文。'.repeat(600), locator: {} }
    ])
    const want = desiredChunks().filter((c) => c.parentId === 's')
    expect(want[0].hash).toBe(hashText('合成资料', '合成内容足够检索。'))
    expect(want[1].text).toBe('合成章节\n' + '中文正文。'.repeat(600))
    await syncIndex(
      () => {},
      () => false
    )
    expect(f.inputs[1]).toHaveLength(1800)
    expect(f.sql!.prepare('SELECT count(*) n FROM vec_chunks').get()).toEqual({ n: 2 })
  })
  it('后续云端批次维度出错时停止本轮并移除本轮写入，不留下半个索引', async () => {
    apply(sqlFiles())
    source()
    segments.replaceSegments(
      's',
      Array.from({ length: 33 }, (_, i) => ({ kind: 'paragraph', text: `第${i}条合成检索正文用于维度保护验证。`, locator: {} }))
    )
    f.failAt = 2
    await expect(
      syncIndex(
        () => {},
        () => false
      )
    ).rejects.toThrow('768')
    expect(f.sql!.prepare('SELECT count(*) n FROM vec_chunks').get()).toEqual({ n: 0 })
    expect(f.sql!.prepare('SELECT count(*) n FROM chunks').get()).toEqual({ n: 0 })
    expect(f.status).toMatchObject({ state: 'error' })
  })
  it('迁移保留旧段、识别缓存和FTS，并支持同页多需求及章节搜索', () => {
    const files = sqlFiles(),
      isNew = (p: string) => /knowledge_retrieval|segments_fts_heading/.test(p)
    apply(files.filter((p) => !isNew(p)))
    source()
    f.sql!.prepare(
      'INSERT INTO source_segments(id,source_id,ordinal,kind,locator,text,hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run('old', 's', 0, 'page', '{"value":"page=1"}', '旧库稀有正文', hashText('page', '旧库稀有正文'), 1, 1)
    f.sql!.exec("INSERT INTO source_pages(source_id,page,need,status,text,updated_at) VALUES('s',1,'table','done','缓存稀有文字',1)")
    apply(files.filter(isNew))
    expect(f.sql!.prepare('SELECT text,heading FROM source_segments WHERE id=?').get('old')).toEqual({ text: '旧库稀有正文', heading: '' })
    expect(f.sql!.prepare('SELECT parse_version FROM sources WHERE id=?').get('s')).toEqual({ parse_version: 0 })
    expect(f.sql!.prepare('SELECT segment_id FROM segments_fts WHERE segments_fts MATCH ?').all('"稀有正文"')).toEqual([
      { segment_id: 'old' }
    ])
    f.sql!.exec("INSERT INTO source_pages(source_id,page,need,updated_at) VALUES('s',1,'figure',2)")
    expect(f.sql!.prepare('SELECT text FROM source_pages WHERE need=?').get('table')).toEqual({ text: '缓存稀有文字' })
    f.sql!.exec("UPDATE source_segments SET heading='第三章合成' WHERE id='old'")
    expect(f.sql!.prepare('SELECT segment_id FROM segments_fts WHERE segments_fts MATCH ?').all('"第三章合成"')).toEqual([
      { segment_id: 'old' }
    ])
  })
  it('未改片段和空路径哈希沿用ID，路径参与身份和查询', () => {
    apply(sqlFiles())
    source()
    const input = [{ kind: 'paragraph', locator: {}, text: '合成证据必须完整保存。' }]
    segments.replaceSegments('s', input)
    const old = segments.listSegments('s')[0]
    expect(f.sql!.prepare('SELECT hash FROM source_segments WHERE id=?').get(old.id)).toEqual({
      hash: hashText(input[0].kind, input[0].text)
    })
    segments.replaceSegments('s', input)
    expect(segments.listSegments('s')[0].id).toBe(old.id)
    segments.replaceSegments('s', [{ ...input[0], heading: '第一章' }])
    const next = segments.listSegments('s')[0]
    expect(next.id).not.toBe(old.id)
    expect(next.heading).toBe('第一章')
    expect(segments.resolveSegmentId(old.id)).toBe(next.id)
    expect(segments.getSegment(old.id)?.id).toBe(next.id)
  })
  it('重切后按页重叠与相似度写别名，批注改写且历史链压平', () => {
    apply(sqlFiles())
    source()
    const input = [{ kind: 'page', locator: { value: 'page=1' }, text: '合成冷却参数与验收范围必须同时核查。' }]
    segments.replaceSegments('s', input)
    const old = segments.listSegments('s')[0]
    f.sql!.prepare('INSERT INTO annotations(id,target_type,target_id,selector,motivation,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(
      'a',
      'source',
      's',
      JSON.stringify({ ownerId: old.id, quote: '冷却参数' }),
      'highlighting',
      1,
      1
    )
    segments.replaceSegments('s', [
      { kind: 'page', locator: { value: 'page=2' }, text: input[0].text + '范围外' },
      { kind: 'page', heading: '验收', locator: { value: 'page=1', pageEnd: 2 }, text: input[0].text + '附加条件。' }
    ])
    const selected = segments.listSegments('s')[1]
    expect(segments.resolveSegmentId(old.id)).toBe(selected.id)
    expect(JSON.parse((f.sql!.prepare('SELECT selector FROM annotations WHERE id=?').get('a') as { selector: string }).selector)).toEqual({
      ownerId: selected.id,
      quote: '冷却参数'
    })
    segments.replaceSegments('s', [{ ...input[0], heading: '新验收', text: input[0].text + '附加条件。下一条件。' }])
    const last = segments.listSegments('s')[0]
    expect(segments.resolveSegmentId(old.id)).toBe(last.id)
    expect(segments.resolveSegmentId(selected.id)).toBe(last.id)
    expect(f.sql!.prepare('SELECT new_id FROM segment_aliases WHERE old_id=?').get(old.id)).toEqual({ new_id: last.id })
    segments.deleteSegments('s')
    expect(segments.resolveSegmentId(old.id)).toBeNull()
    expect(f.sql!.prepare('SELECT count(*) n FROM segment_aliases').get()).toEqual({ n: 0 })
  })
  it('不同页和低相似度不误配，失败事务不留下半写结果', () => {
    apply(sqlFiles())
    source()
    segments.replaceSegments('s', [{ kind: 'page', locator: { value: 'page=1' }, text: '这是一段完全独立的合成验收证据。' }])
    const old = segments.listSegments('s')[0]
    segments.replaceSegments('s', [{ kind: 'page', locator: { value: 'page=3' }, text: old.text }])
    // 内容相同会沿用 ID；下一次重切才需要通过定位约束建立别名。
    const reused = segments.listSegments('s')[0]
    expect(reused.id).toBe(old.id)
    segments.replaceSegments('s', [
      { kind: 'page', locator: { value: 'page=4' }, text: old.text + '其他页面' },
      { kind: 'page', locator: { value: 'page=3' }, text: '橙色小鸟正在唱歌。' }
    ])
    expect(segments.resolveSegmentId(old.id)).toBeNull()
    const before = segments.listSegments('s')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => segments.replaceSegments('s', [{ kind: 'paragraph', locator: cyclic, text: '会回滚的资料内容。' }])).toThrow()
    expect(segments.listSegments('s')).toEqual(before)
  })
})

it('owning conversation resolves attachment aliases; defaults and unrelated conversations remain isolated', () => {
  apply(sqlFiles())
  source()
  f.sql!.exec(
    "UPDATE sources SET space='attachment',ai_excluded=1 WHERE id='s'; INSERT INTO conversations(id,title,created_at,updated_at) VALUES('owner','Owner',1,1),('other','Other',1,1); INSERT INTO conversation_attachments(conversation_id,source_id,created_at) VALUES('owner','s',1)"
  )
  segments.replaceSegments('s', [{ kind: 'paragraph', text: 'Synthetic private attachment', locator: {} }])
  const old = segments.listSegments('s')[0].id
  segments.replaceSegments('s', [{ kind: 'paragraph', text: 'Synthetic private attachment', heading: 'Chapter', locator: {} }])
  expect(segments.getSegment(old)).toBeNull()
  expect(segments.getSegment(old, 'other')).toBeNull()
  expect(segments.getSegment(old, 'owner')?.text).toBe('Synthetic private attachment')
})
