import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { eq, getTableColumns, getTableName, sql, type SQL } from 'drizzle-orm'
import { SQLiteSyncDialect, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import { mistakes, notes, sources } from '../../db/schema'
import type { JobKind } from '../../services/jobs'

type Row = typeof mistakes.$inferSelect
type ModelRequest = { system: string; prompt: string; tools?: unknown }
const state = vi.hoisted(() => ({
  sqlite: null as DatabaseSync | null,
  jobs: new Map<string, JobKind>(),
  requests: [] as ModelRequest[],
  generate: vi.fn<(request: ModelRequest) => Promise<unknown>>(),
  beforeBuild: null as (() => void) | null,
  buildCount: 0,
  tabs: [] as { url: string; sensitive: boolean; incognito: boolean }[],
  inbox: new Map<string, { deletedAt: number | null; assetId: string | null; origin: { url?: string; recordingSourceId?: string } }>(),
  settings: { language: 'zh-CN', browser: { aiBlockedSites: ['blocked.example'] }, ai: { chat: { providerId: 'test-provider', model: 'deepseek-flash' } } }
}))

const dialect = new SQLiteSyncDialect()
function statement(query: SQL) {
  const compiled = dialect.sqlToQuery(query)
  return { query: state.sqlite!.prepare(compiled.sql), args: compiled.params as SQLInputValue[] }
}
function write(table: SQLiteTable, fields: Record<string, unknown>): void {
  const columns = getTableColumns(table)
  const entries = Object.entries(fields)
  const prepared = statement(sql`insert into ${table} (${sql.join(entries.map(([key]) => sql.identifier(columns[key].name)), sql`, `)}) values (${sql.join(entries.map(([key, value]) => sql.param(value, columns[key])), sql`, `)})`)
  prepared.query.run(...prepared.args)
}
function edit(table: SQLiteTable, id: string, fields: Record<string, unknown>): void {
  const columns = getTableColumns(table)
  const prepared = statement(sql`update ${table} set ${sql.join(Object.entries(fields).map(([key, value]) => sql`${sql.identifier(columns[key].name)} = ${sql.param(value, columns[key])}`), sql`, `)} where ${columns.id} = ${id}`)
  prepared.query.run(...prepared.args)
}

// 只替换存储连接与模型网络边界；过滤、权限检查、发送/回退和 worker 落盘均运行真实代码。
// Drizzle 条件在内存 SQLite 执行，避免测试适配器自行模拟分页逻辑。
const memoryDb = {
  select: () => ({ from: <TTable extends SQLiteTable>(table: TTable) => {
    const columns = getTableColumns(table)
    let condition: SQL | undefined, ordering: SQL[] = [], maximum: number | undefined
    const all = () => {
      const prepared = statement(sql`select ${sql.join(Object.entries(columns).map(([key, column]) => sql`${column} as ${sql.identifier(key)}`), sql`, `)} from ${table}${condition ? sql` where ${condition}` : sql``}${ordering.length ? sql` order by ${sql.join(ordering, sql`, `)}` : sql``}${maximum === undefined ? sql`` : sql` limit ${maximum}`}`)
      return prepared.query.all(...prepared.args).map((row) => Object.fromEntries(Object.entries(columns).map(([key, column]) => [key, row[key] === null ? null : column.mapFromDriverValue(row[key])]))) as TTable['$inferSelect'][]
    }
    const query = {
      where: (value: SQL) => { condition = value; return query },
      orderBy: (...values: SQL[]) => { ordering = values; return query },
      limit: (value: number) => { maximum = value; return query },
      all,
      get: () => all()[0]
    }
    return query
  } }),
  update: (table: SQLiteTable) => ({ set: (fields: Record<string, unknown>) => ({ where: (condition: SQL) => ({ run: () => {
    const columns = getTableColumns(table)
    const prepared = statement(sql`update ${table} set ${sql.join(Object.entries(fields).map(([key, value]) => sql`${sql.identifier(columns[key].name)} = ${sql.param(value, columns[key])}`), sql`, `)} where ${condition}`)
    return prepared.query.run(...prepared.args)
  } }) }) })
}

vi.mock('../../db', () => ({ getDb: () => memoryDb }))
vi.mock('electron', () => ({ nativeImage: {} }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn() } }))
vi.mock('ai', () => ({
  streamText: (request: ModelRequest) => {
    state.requests.push(request)
    const result = state.generate(request) as Promise<ReturnType<typeof response>>
    return {
      fullStream: (async function* () { const r = await result; yield { type: 'finish', finishReason: 'stop', totalUsage: r.usage } })(),
      get text() { return result.then((r) => r.text) },
      get toolCalls() { return result.then((r) => r.toolCalls) },
      get usage() { return result.then((r) => r.usage) },
      get finishReason() { return Promise.resolve('stop') }
    }
  },
  generateText: (request: ModelRequest) => { state.requests.push(request); return state.generate(request) },
  tool: (value: unknown) => value
}))
vi.mock('../../services/ai/model', () => ({ buildModel: () => {
  state.buildCount++
  state.beforeBuild?.()
  return { model: 'test-model' }
} }))
vi.mock('../../services/ai/providers', () => ({ getProviderRow: () => ({ enabled: true, modelCaps: '{}' }) }))
vi.mock('../../events', () => ({ emit: vi.fn() }))
vi.mock('../../services/assets', () => ({ assetPath: vi.fn(), assetUrl: vi.fn(), importBytes: vi.fn() }))
vi.mock('../../services/categories', () => ({ listCategories: vi.fn(), createCategory: vi.fn() }))
vi.mock('../../services/notes', () => ({ createNote: vi.fn(), getNote: vi.fn() }))
vi.mock('../../services/docs', () => ({ loadDoc: vi.fn(), pushUpdate: vi.fn(), stateToJSON: vi.fn() }))
vi.mock('../../services/proposals', () => ({ createProposal: vi.fn(), listProposals: vi.fn(), resolveOp: vi.fn() }))
vi.mock('../../services/device', () => ({ deviceId: () => 'test-device' }))
vi.mock('../../services/recognize', () => ({ recognizeRegionDetailed: vi.fn() }))
vi.mock('../../services/settings', () => ({ getSettings: () => state.settings }))
vi.mock('../../services/learner', () => ({ listConcepts: () => [], describeConcept: vi.fn(), recordConcept: vi.fn() }))
vi.mock('../../services/jobs', () => ({ enqueue: vi.fn(), retryOrEnqueue: vi.fn(), registerJobKind: (kind: string, definition: JobKind) => state.jobs.set(kind, definition) }))
vi.mock('../../services/review', () => ({ syncCards: vi.fn() }))
vi.mock('../../services/mistakesVariants', () => ({ registerVariantJobs: vi.fn(), replenish: vi.fn(), practice: vi.fn(), flag: vi.fn(), check: vi.fn(), useVariant: vi.fn(), variants: vi.fn(), variantStats: vi.fn() }))
vi.mock('../../services/inbox', () => ({ get: (id: string) => state.inbox.get(id) }))
vi.mock('../../services/browser/capture', () => ({ prepare: vi.fn() }))
vi.mock('../../services/browser/manager', () => ({ browserState: () => ({ tabs: state.tabs }) }))

import { registerMistakeJobs } from '../../services/mistakes'
import { registerMistakeEntryGuards } from '../../services/mistakeEntries'

const TARGET = '123e4567-e89b-42d3-a456-426614174000'
const original = { question: '求 2+2。', myAnswer: '2+2=5', correctAnswer: '4', solution: '2+2=4', subject: 'math', regions: [] }
const diagnosis = { cause: 'calculation', evidence: '2+2=5', reason: '“2+2=5”这一步错了，应为 2+2=4。', concepts: ['加法'] }
function response(request: ModelRequest) {
  const output = request.system.startsWith('你将题目原件') ? { questions: [original] } : diagnosis
  return { toolCalls: request.tools ? [{ toolName: 'submit', input: output }] : [], text: JSON.stringify(output), usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, outputTokenDetails: { textTokens: 1, reasoningTokens: 0 } } }
}
function row(id: string, fields: Partial<Row> = {}): Row {
  return { id, noteId: null, rowId: null, sourceKind: 'manual', sourceRef: null, assetId: null, cropAssetId: null,
    question: `reference ${id}`, myAnswer: `answer ${id}`, correctAnswer: '4', solution: '2+2=4', answerOrigin: 'image', verified: true,
    cause: 'calculation', causeReason: `corrected reason ${id}`, concepts: '["加法"]', subject: 'math', flags: '[]', diagnosisCorrection: true,
    ingestKey: null, createdAt: 1, updatedAt: 1, deletedAt: null, updatedBy: 'test', ...fields }
}
function target(): Row { return memoryDb.select().from(mistakes).where(eq(mistakes.id, TARGET)).get()! }
const diagnoseRequests = () => state.requests.filter((request) => request.system.startsWith('你诊断用户'))
function correctionQuestions(): string[] {
  const data = JSON.parse(diagnoseRequests()[0].prompt.replace(/^<mistake-data>|<\/mistake-data>$/g, '')) as { corrections: { question: string }[] }
  return data.corrections.map((correction) => correction.question)
}
async function run(): Promise<unknown> {
  return state.jobs.get('mistake-split')!.run({ id: TARGET, text: '求 2+2。我的答案 2+2=5。' }, { step: <T>(_key: string, _sourceId: string | null, fn: () => Promise<T>) => fn(), isCanceled: () => false, progress: () => undefined, worker: async <T>() => undefined as T })
}
function notAdmitted(): void {
  expect(target()).toMatchObject({ question: 'target original', cause: 'unknown', causeReason: '', flags: '["failed"]' })
}

beforeEach(() => {
  state.sqlite = new DatabaseSync(':memory:')
  for (const table of [mistakes, notes, sources]) {
    const columns = Object.values(getTableColumns(table))
    state.sqlite.exec(`create table "${getTableName(table)}" (${columns.map((column) => `"${column.name}" ${column.getSQLType()}`).join(', ')})`)
  }
  state.requests = []; state.tabs = []; state.inbox.clear(); state.beforeBuild = null; state.buildCount = 0
  state.generate.mockReset().mockImplementation(async (request) => response(request))
  write(mistakes, row(TARGET, { question: 'target original', cause: 'unknown', causeReason: '', diagnosisCorrection: false, ingestKey: 'batch:0', flags: '["processing"]' }))
  registerMistakeEntryGuards()
  registerMistakeJobs()
})
afterEach(() => { state.sqlite?.close(); state.sqlite = null })

describe('mistake diagnosis correction privacy', () => {
  it('filters the full cloud policy before choosing five recent allowed corrections', async () => {
    write(notes, { id: 'private-note', aiExcluded: true })
    write(notes, { id: 'deleted-note', deletedAt: 1, aiExcluded: false })
    write(sources, { id: 'private-source', aiExcluded: true })
    write(sources, { id: 'incognito-source', url: 'https://public.example/question', aiExcluded: false })
    state.tabs = [{ url: 'https://public.example/question', incognito: true, sensitive: false }]
    state.inbox.set('recorded', { deletedAt: null, assetId: null, origin: { recordingSourceId: 'private-source' } })
    const blocked = [
      row('local-only', { flags: '["local-only"]' }),
      row('private-note', { noteId: 'private-note' }),
      row('deleted-note', { noteId: 'deleted-note' }),
      row('missing-note', { noteId: 'missing-note' }),
      row('sensitive-url', { sourceRef: 'https://blocked.example/question' }),
      row('excluded-source', { sourceKind: 'browser', sourceRef: 'jiwei://source/private-source' }),
      row('incognito', { sourceKind: 'browser', sourceRef: 'jiwei://source/incognito-source' }),
      row('private-recording', { sourceKind: 'inbox', sourceRef: 'jiwei://inbox/recorded' }),
      row('unbound-browser', { sourceKind: 'browser' }),
      row('deleted-mistake', { deletedAt: 1 })
    ]
    blocked.forEach((reference, index) => write(mistakes, { ...reference, updatedAt: 1000 - index }))
    for (let i = 1; i <= 6; i++) write(mistakes, row(`allowed-${i}`, { updatedAt: 100 - i }))
    await run()
    expect(correctionQuestions()).toEqual(['reference allowed-1', 'reference allowed-2', 'reference allowed-3', 'reference allowed-4', 'reference allowed-5'])
    expect(target()).toMatchObject({ cause: 'calculation', causeReason: diagnosis.reason, flags: '[]' })
  })

  it('continues past more than fifty blocked rows with tied update timestamps', async () => {
    for (let i = 0; i < 75; i++) write(mistakes, row(`z-private-${String(i).padStart(3, '0')}`, { flags: '["local-only"]', updatedAt: 100 }))
    for (const id of ['e', 'd', 'c', 'b', 'a', '0']) write(mistakes, row(id, { updatedAt: 100 }))
    await run()
    expect(correctionQuestions()).toEqual(['reference e', 'reference d', 'reference c', 'reference b', 'reference a'])
  })

  it('rechecks a selected note reference at the actual send boundary', async () => {
    write(notes, { id: 'linked-note', aiExcluded: false })
    write(mistakes, row('reference', { noteId: 'linked-note' }))
    state.beforeBuild = () => { if (state.buildCount === 2) edit(notes, 'linked-note', { aiExcluded: true }) }
    await expect(run()).rejects.toThrow(/仅本地/)
    expect(diagnoseRequests()).toHaveLength(0)
    notAdmitted()
  })

  it.each(['local-only', 'private-note', 'sensitive-browser', 'deleted-reference'] as const)('rejects a successful diagnosis when its reference becomes %s in flight', async (change) => {
    write(notes, { id: 'linked-note', aiExcluded: false })
    write(sources, { id: 'linked-source', aiExcluded: false, url: 'https://public.example/question' })
    write(mistakes, row('reference', { noteId: 'linked-note', sourceKind: 'browser', sourceRef: 'jiwei://source/linked-source' }))
    state.generate.mockImplementation(async (request) => {
      if (request.system.startsWith('你诊断用户')) {
        if (change === 'local-only') edit(mistakes, 'reference', { flags: '["local-only"]' })
        if (change === 'private-note') edit(notes, 'linked-note', { aiExcluded: true })
        if (change === 'sensitive-browser') state.tabs.push({ url: 'https://public.example/question', incognito: false, sensitive: true })
        if (change === 'deleted-reference') edit(mistakes, 'reference', { deletedAt: 1 })
      }
      return response(request)
    })
    await expect(run()).rejects.toThrow(/仅本地|不存在或已删除/)
    expect(diagnoseRequests()).toHaveLength(1)
    notAdmitted()
  })

  it('does not resend a newly excluded source correction through JSON fallback', async () => {
    write(sources, { id: 'linked-source', aiExcluded: false, url: 'https://public.example/question' })
    write(mistakes, row('reference', { sourceKind: 'browser', sourceRef: 'jiwei://source/linked-source' }))
    state.generate.mockImplementation(async (request) => {
      if (request.system.startsWith('你诊断用户') && request.tools) {
        edit(sources, 'linked-source', { aiExcluded: true })
        throw new Error('simulated tool transport failure')
      }
      return response(request)
    })
    await expect(run()).rejects.toThrow(/仅本地/)
    expect(diagnoseRequests()).toHaveLength(1)
    notAdmitted()
  })

  it('diagnoses the public target with an empty reference array when every correction is private', async () => {
    for (let i = 0; i < 8; i++) write(mistakes, row(`private-${i}`, { flags: '["local-only"]' }))
    await run()
    expect(correctionQuestions()).toEqual([])
    expect(target()).toMatchObject({ cause: 'calculation', causeReason: diagnosis.reason, flags: '[]' })
  })
})
