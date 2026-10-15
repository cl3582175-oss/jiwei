import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getLoadablePath } from 'sqlite-vec'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { JobKind } from '../jobs'

const f = vi.hoisted(() => ({
  sql: null as Database.Database | null,
  db: null as ReturnType<typeof drizzle> | null,
  run: null as
    JobKind<{ sourceId: string; conversationId: string; noteId: string; task: 'summary'; providerId: string; model: string }>['run'] | null,
  prompts: [] as string[],
  title: null as JobKind<{ sourceId: string }>['title'] | null
}))
vi.mock('../../db', () => ({ getDb: () => f.db, getSqlite: () => f.sql }))
vi.mock('../../events', () => ({ emit: () => {} }))
vi.mock('../connections', () => ({ relate: () => {} }))
vi.mock('../notes', () => ({
  createNote: (input: { title: string; aiExcluded?: boolean }) => {
    f.sql!.prepare(
      "INSERT INTO notes(id,title,ai_excluded,doc_version,learned_at,created_at,edited_at,updated_at,updated_by) VALUES('new',?,?,1,1,1,1,1,'test')"
    ).run(input.title, Number(input.aiExcluded ?? false))
    return { id: 'new' }
  }
}))
vi.mock('../proposals', () => ({ createProposal: () => {} }))
vi.mock('../settings', () => ({ getSettings: () => ({ language: 'zh-CN', money: {} }) }))
vi.mock('../recognize', () => ({
  digestWaiting: () => null,
  ensureRecognition: () => null,
  pendingRecognition: () => ({ pending: [], total: 0, done: 0 }),
  sourceRecognition: () => ({ engine: 'off' }),
  unrecognizedPages: () => []
}))
vi.mock('../jobs', () => ({
  PermanentJobError: class extends Error {},
  TemporaryJobError: class extends Error {},
  enqueue: () => 'job',
  registerJobKind: (_name: string, kind: JobKind) => {
    f.run = kind.run
    f.title = kind.title
  }
}))
vi.mock('../ai/request', () => ({
  createModelRequest: (input: { prompt: string }) => ({
    generate: async () => {
      f.prompts.push(input.prompt)
      throw new Error('Controlled model failure')
    }
  })
}))
vi.mock('../ai/structured', () => ({
  quickModel: () => 'controlled',
  structured: async (input: { prompt: string }) => {
    f.prompts.push(input.prompt)
    throw new Error('Controlled model failure')
  }
}))
vi.mock('../ai/tools', () => ({ buildMindmap: () => {}, NestedSchema: {} }))
vi.mock('../agent/pricing', () => ({ costOf: () => ({ cost: null }) }))

beforeEach(() => {
  f.sql = new Database(':memory:')
  f.sql.loadExtension(getLoadablePath())
  for (const file of readdirSync(join(process.cwd(), 'resources/migrations'))
    .filter((p) => p.endsWith('.sql'))
    .sort())
    f.sql.exec(readFileSync(join(process.cwd(), 'resources/migrations', file), 'utf8'))
  f.db = drizzle(f.sql)
  f.prompts = []
  f.sql.exec(
    "INSERT INTO conversations(id,title,created_at,updated_at) VALUES('own','own',1,1); INSERT INTO sources(id,title,kind,space,ai_excluded,created_at,accessed_at,updated_at,updated_by) VALUES('private','SECRET-ATTACHMENT-TITLE','document','attachment',1,1,1,1,'test'); INSERT INTO conversation_attachments(conversation_id,source_id,created_at) VALUES('own','private',1)"
  )
})
afterEach(() => f.sql?.close())

it('整理新建笔记在首次模型请求前就隔离；失败和取消不能公开标题', async () => {
  const { replaceSegments } = await import('../segments')
  replaceSegments('private', [{ kind: 'text', text: 'SECRET-ATTACHMENT-BODY', locator: {} }])
  const d = await import('../digest')
  const { noteHasPrivateAttachments } = await import('../attachmentDerived')
  const input = { sourceId: 'private', conversationId: 'own', task: 'summary' as const, providerId: 'controlled', model: 'controlled' }
  const result = d.startDigest(input)
  expect(f.sql!.prepare('SELECT ai_excluded FROM notes WHERE id=?').get(result.noteId)).toEqual({ ai_excluded: 1 })
  expect(noteHasPrivateAttachments(result.noteId)).toBe(true)
  d.registerDigestJob()
  expect(f.title!(input)).toBe('整理《对话附件》为总结')
  const ctx = {
    worker: vi.fn(),
    progress: vi.fn(),
    yieldPoint: () => {},
    isCanceled: () => false,
    step: <T>(_key: string, _source: string | null, fn: () => Promise<T>) => fn()
  }
  await expect(f.run!({ ...input, noteId: result.noteId }, ctx)).rejects.toThrow('Controlled model failure')
  expect(noteHasPrivateAttachments(result.noteId)).toBe(true)
  expect(() => f.run!({ ...input, noteId: result.noteId }, { ...ctx, isCanceled: () => true })).toThrow('canceled')
  expect(noteHasPrivateAttachments(result.noteId)).toBe(true)
})

it('整理已有目标笔记先隔离，并且模型只能读取表格前200行', async () => {
  f.sql!.exec("INSERT INTO notes(id,doc_version,learned_at,created_at,edited_at,updated_at,updated_by) VALUES('existing',1,1,1,1,1,'test')")
  const { replaceSegments } = await import('../segments')
  const { tableSegments } = await import('../parsers/ooxml')
  replaceSegments(
    'private',
    tableSegments('Sheet', [
      { row: 1, cells: ['value'] },
      ...Array.from({ length: 300 }, (_, i) => ({ row: i + 2, cells: [i === 249 ? 'ROW250-NOT-FOR-MODEL' : `row${i}`] }))
    ])
  )
  const d = await import('../digest')
  const input = {
    sourceId: 'private',
    conversationId: 'own',
    task: 'summary' as const,
    noteId: 'existing',
    providerId: 'controlled',
    model: 'controlled'
  }
  d.startDigest(input)
  expect(f.sql!.prepare("SELECT ai_excluded FROM notes WHERE id='existing'").get()).toEqual({ ai_excluded: 1 })
  d.registerDigestJob()
  await expect(
    f.run!(input, {
      worker: vi.fn(),
      progress: vi.fn(),
      yieldPoint: () => {},
      isCanceled: () => false,
      step: <T>(_key: string, _source: string | null, fn: () => Promise<T>) => fn()
    })
  ).rejects.toThrow('Controlled model failure')
  expect(f.prompts.join('\n')).not.toContain('ROW250-NOT-FOR-MODEL')
})
