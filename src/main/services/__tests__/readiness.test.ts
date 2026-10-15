import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getLoadablePath } from 'sqlite-vec'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const f = vi.hoisted(() => ({
  sql: null as Database.Database | null,
  db: null as ReturnType<typeof drizzle> | null,
  engine: 'ready',
  running: false,
  vector: false,
  transcript: false,
  mode: 'local'
}))
vi.mock('../../db', () => ({ getDb: () => f.db, getSqlite: () => f.sql }))
vi.mock('../recognize', () => ({
  sourceRecognition: () => ({ needs: { scan: 1, table: 0, figure: 0 }, total: 1, done: 0, failed: 0, running: f.running, engine: f.engine })
}))
vi.mock('../ai/embedding', () => ({
  getStatus: () => ({ state: f.vector ? 'ready' : 'missing' }),
  currentModelId: () => 'controlled',
  isReady: async () => f.vector
}))
vi.mock('../asr', () => ({ canAutoTranscribe: () => f.transcript }))
vi.mock('../settings', () => ({ getSettings: () => ({ language: 'en', ai: { embedding: { mode: f.mode } } }) }))
vi.mock('../segmentJobs', () => ({ enqueueSegment: () => {} }))
import * as ready from '../readiness'
import { sourceIndexStatus } from '../ai/sourceIndexStatus'
import { sourceJobTitle } from '../sourceJobTitle'
import { setMessageLanguage } from '../../lib/messages'
import { readinessMessage } from '@shared/readiness'

beforeEach(() => {
  f.engine = 'ready'
  f.running = false
  f.vector = false
  f.transcript = false
  f.mode = 'local'
  f.sql = new Database(':memory:')
  f.sql.loadExtension(getLoadablePath())
  f.db = drizzle(f.sql)
  const dir = join(process.cwd(), 'resources/migrations')
  for (const file of readdirSync(dir)
    .filter((p) => p.endsWith('.sql'))
    .sort())
    f.sql.exec(readFileSync(join(dir, file), 'utf8'))
})
afterEach(() => f.sql?.close())
function source(id: string, ext = 'pdf', kind = 'pdf', space = 'library', excluded = 0) {
  f.sql!.prepare('INSERT INTO assets(id,ext,size,created_at) VALUES(?,?,?,1)').run(id + '-asset', ext, 10)
  f.sql!.prepare(
    'INSERT INTO sources(id,title,kind,asset_id,space,ai_excluded,accessed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1,1)'
  ).run(id, id, kind, id + '-asset', space, excluded)
}
function segment(id: string, text = 'Synthetic readable content', kind = 'paragraph', ordinal = 0) {
  f.sql!.prepare(
    "INSERT INTO source_segments(id,source_id,ordinal,kind,text,hash,locator,created_at,updated_at) VALUES(?,?,?,?,?,'h','{}',1,1)"
  ).run(id + '-' + ordinal, id, ordinal, kind, text)
}
function job(id: string, status: string, at: number) {
  f.sql!.prepare(
    "INSERT INTO jobs(id,kind,payload,dedupe_key,status,run_after,created_at,updated_at) VALUES(?,'source.segment',?,?,?,1,?,?)"
  ).run(id + at, JSON.stringify({ sourceId: id }), 'segment:' + id, status, at, at)
}
function scan(id: string, page: number, status = 'pending') {
  f.sql!.prepare("INSERT INTO source_pages(source_id,page,need,status,updated_at) VALUES(?,?,'scan',?,1)").run(id, page, status)
}
it('parsing is first, unsupported format uses registry note, latest success clears old failure', () => {
  source('s', 'xls', 'document')
  job('s', 'failed', 1)
  job('s', 'queued', 2)
  expect(ready.sourceReadiness('s')).toEqual({ state: 'preparing', reason: 'parsing' })
  f.sql!.exec("DELETE FROM jobs WHERE status='queued'")
  expect(ready.sourceReadiness('s')).toMatchObject({
    state: 'unreadable',
    reason: 'unsupported',
    action: null,
    note: expect.stringContaining('.xlsx')
  })
  source('p')
  job('p', 'failed', 1)
  expect(ready.sourceReadiness('p')).toEqual({ state: 'unreadable', reason: 'failed', action: null })
  segment('p')
  job('p', 'done', 2)
  expect(ready.sourceReadiness('p')).toEqual({ state: 'ready' })
})
it('scan pages distinguish unreadable and partial and follow actual recognizer availability', () => {
  source('s')
  scan('s', 1)
  scan('s', 2, 'failed')
  scan('s', 3, 'done')
  expect(ready.sourceReadiness('s')).toEqual({ state: 'unreadable', reason: 'scan-pending', pending: 2, total: 3, action: 'recognize' })
  segment('s')
  f.engine = 'needs-install'
  expect(ready.sourceReadiness('s')).toEqual({
    state: 'partial',
    reason: 'scan-pending',
    pending: 2,
    total: 3,
    action: 'install-recognizer'
  })
  f.engine = 'off'
  expect(ready.sourceReadiness('s')).toMatchObject({ state: 'partial', action: null })
  f.sql!.exec("UPDATE source_pages SET status='done'")
  expect(ready.sourceReadiness('s')).toEqual({ state: 'ready' })
})
it('audio needs transcript, empty content stays unreadable, missing vectors do not imply empty text', () => {
  source('a', 'mp3', 'audio')
  segment('a', 'Cover image', 'figure')
  expect(ready.sourceReadiness('a')).toEqual({ state: 'unreadable', reason: 'needs-transcript', action: null })
  f.transcript = true
  expect(ready.sourceReadiness('a')).toMatchObject({ action: 'transcribe' })
  segment('a', 'Spoken evidence', 'transcript', 1)
  expect(ready.sourceReadiness('a')).toEqual({ state: 'ready' })
  source('empty')
  segment('empty', '   ')
  expect(ready.sourceReadiness('empty')).toEqual({ state: 'unreadable', reason: 'empty', action: null })
  source('text')
  segment('text')
  segment('text', 'Second', 'paragraph', 1)
  expect(ready.sourceReadiness('text')).toEqual({ state: 'ready' })
  f.vector = true
  expect(ready.sourceReadiness('text')).toEqual({ state: 'preparing', reason: 'indexing', progress: 0 })
  const row = f
    .sql!.prepare(
      "INSERT INTO chunks(owner_type,owner_id,parent_type,parent_id,hash,model,created_at) VALUES('segment','text-0','source','text','h','controlled',1) RETURNING rowid"
    )
    .get() as { rowid: number }
  f.sql!.prepare('INSERT INTO vec_chunks(rowid,embedding) VALUES(?,?)').run(
    BigInt(row.rowid),
    Buffer.from(new Float32Array([1, ...Array(511).fill(0)]).buffer)
  )
  expect(ready.sourceReadiness('text')).toEqual({ state: 'preparing', reason: 'indexing', progress: 0.5 })
})
it('batch status hides excluded/deleted/unowned attachments and permits only owning conversation', () => {
  source('public')
  source('private', 'pdf', 'pdf', 'library', 1)
  source('gone')
  source('attachment', 'pdf', 'pdf', 'attachment', 1)
  for (const id of ['public', 'private', 'gone', 'attachment']) segment(id)
  f.sql!.exec(
    "UPDATE sources SET deleted_at=1 WHERE id='gone'; INSERT INTO conversations(id,title,created_at,updated_at) VALUES('owner','Owner',1,1),('other','Other',1,1); INSERT INTO conversation_attachments(conversation_id,source_id,created_at) VALUES('owner','attachment',1)"
  )
  const ids = ['public', 'private', 'gone', 'attachment']
  expect(ready.readinessMany(ids)).toEqual({ public: { state: 'ready' } })
  expect(ready.readinessMany(ids, 'other')).toEqual({ public: { state: 'ready' } })
  expect(ready.readinessMany(ids, 'owner')).toEqual({ public: { state: 'ready' }, attachment: { state: 'ready' } })
  f.sql!.exec('UPDATE conversation_attachments SET removed_at=2')
  expect(ready.readinessMany(ids, 'owner')).toEqual({ public: { state: 'ready' } })
})

it('persisted notices remain historical, validate old JSON and hide revoked sources', () => {
  source('s')
  scan('s', 1)
  const items = ready.readinessForSources(['s'])
  expect(items).toHaveLength(1)
  expect(items[0].readiness).toMatchObject({ state: 'unreadable', reason: 'scan-pending' })
  f.sql!.exec("UPDATE source_pages SET status='done'")
  segment('s')
  expect(ready.storedReadiness(JSON.stringify({ readiness: items }), '')).toEqual(items)
  expect(ready.storedReadiness('{bad', '')).toEqual([])
  expect(ready.storedReadiness(JSON.stringify({ attachmentSourceIds: ['s'] }), '')).toEqual([])
  f.sql!.exec("UPDATE sources SET ai_excluded=1 WHERE id='s'")
  expect(ready.storedReadiness(JSON.stringify({ readiness: items }), '')).toEqual([])
})

it('short readable segments finish without impossible vectors and cloud attachments stay keyword-readable', () => {
  source('short')
  segment('short', '甲段')
  segment('short', '乙段', 'paragraph', 1)
  f.vector = true
  expect(ready.sourceReadiness('short')).toEqual({ state: 'ready' })
  source('attachment', 'pdf', 'pdf', 'attachment', 1)
  segment('attachment')
  f.sql!.exec(
    "INSERT INTO conversations(id,title,created_at,updated_at) VALUES('owner','Owner',1,1); INSERT INTO conversation_attachments(conversation_id,source_id,created_at) VALUES('owner','attachment',1)"
  )
  f.mode = 'cloud'
  expect(ready.sourceReadiness('attachment', 'owner')).toEqual({ state: 'ready' })
  f.mode = 'local'
  expect(ready.sourceReadiness('attachment', 'owner')).toEqual({ state: 'preparing', reason: 'indexing', progress: 0 })
})

it('index progress follows the same library and owning-conversation visibility as readiness', async () => {
  source('attachment', 'pdf', 'pdf', 'attachment', 1)
  segment('attachment')
  f.sql!.exec(
    "INSERT INTO conversations(id,title,created_at,updated_at) VALUES('owner','Owner',1,1); INSERT INTO conversation_attachments(conversation_id,source_id,created_at) VALUES('owner','attachment',1)"
  )
  expect(await sourceIndexStatus('attachment')).toEqual({ segments: 0, indexable: 0, embedded: 0, semantic: false })
  expect(await sourceIndexStatus('attachment', 'owner')).toMatchObject({ segments: 1, indexable: 1 })
})

it('while recognition is running, scan readiness says so and offers no start button', () => {
  source('r')
  segment('r')
  scan('r', 1)
  scan('r', 2, 'done')
  f.running = true
  const r = ready.sourceReadiness('r')
  expect(r).toEqual({ state: 'partial', reason: 'scan-pending', pending: 1, total: 2, action: null, recognizing: true })
  expect(readinessMessage(r)).toEqual({ key: 'readyScanPartialRunning', values: { n: 1 } })
  expect(ready.readinessDescription(r, true)).toBe('正在识别扫描页，还剩 1 页，识别完成前这些页搜不到')
  f.running = false
  expect(ready.readinessDescription(ready.sourceReadiness('r'), true)).toBe('2 页扫描页中还有 1 页没识别，这些页搜不到')
  f.sql!.exec("DELETE FROM source_segments WHERE source_id='r'")
  f.running = true
  const all = ready.sourceReadiness('r')
  expect(readinessMessage(all)).toEqual({ key: 'readyScanAllRunning' })
  expect(ready.readinessDescription(all, true)).toBe('正在识别扫描件，识别完成前内容搜不到')
})

it('background job titles never reveal a chat attachment file name', () => {
  source('lib')
  source('att', 'pdf', 'pdf', 'attachment')
  setMessageLanguage('zh-CN')
  expect(sourceJobTitle('lib')).toBe('lib')
  expect(sourceJobTitle('att')).toBe('对话附件')
  setMessageLanguage('en')
  expect(sourceJobTitle('att')).toBe('Chat attachment')
  setMessageLanguage('zh-CN')
})
