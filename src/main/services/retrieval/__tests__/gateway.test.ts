import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getLoadablePath } from 'sqlite-vec'
import { BACKEND_IDS, type BackendId, type WebResult } from '@shared/retrieval'
import type { DB } from '../../../db'
import * as schema from '../../../db/knowledgeSchema'

const state = vi.hoisted(() => ({
  db: null as DB | null,
  sqlite: null as Database.Database | null,
  searches: new Map<string, ReturnType<typeof vi.fn>>(),
  providers: new Map<string, { kind: string; baseUrl: string; updatedAt: number; key?: string }>()
}))
vi.mock('../../../db', () => ({ getDb: () => state.db, getSqlite: () => state.sqlite }))
vi.mock('electron', () => ({ app: { getLocale: () => 'zh-CN' }, nativeTheme: {}, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn() } }))
vi.mock('../../ai/providers', () => ({
  getProviderRow: (id: string) => {
    const row = state.providers.get(id)
    if (!row) throw new Error('Not found')
    return row
  },
  decryptKey: (row: { updatedAt: number; key?: string }) => row.key ?? 'synthetic-key-' + row.updatedAt
}))
vi.mock('../../mcp/secrets', () => ({ sealJson: () => Buffer.from('sealed-fixture'), openJson: () => 'synthetic-key' }))
vi.mock('../backends/index', async () => {
  const { BackendError } = await import('../backends/common')
  const ids = ['bocha', 'zhipu', 'tavily', 'brave', 'exa', 'serper', 'searxng', 'deepseek', 'openalex', 'semanticscholar', 'arxiv']
  const BACKENDS = Object.fromEntries(
    ids.map((id) => {
      const search = vi.fn()
      state.searches.set(id, search)
      return [id, { id, search }]
    })
  )
  return { BackendError, BACKENDS }
})
import { withRun } from '../../agent/context'
import { setSettings } from '../../settings'
import { saveBackend } from '../backends/store'
import { localDate } from '../../stats'
import { emit } from '../../../events'

const result = (backend: BackendId, rank = 1, url = `https://${backend}.example.org/learning`): WebResult => ({
  backend,
  rank,
  url,
  title: `${backend} fixture`,
  snippet: 'Visible controlled evidence'
})
const run = <T>(fn: () => T): T => withRun({ purpose: 'chat', caller: 'assistant' }, fn)
let day = 0

function dynamicPrivateContent(kind: 'note' | 'source' = 'note', title = '动态保密查询标题'): () => void {
  const common = { id: 'dynamic-private', title, aiExcluded: false, createdAt: 1, updatedAt: 1 }
  if (kind === 'note')
    state
      .db!.insert(schema.notes)
      .values({ ...common, plainText: '', learnedAt: 1, editedAt: 1 })
      .run()
  else
    state
      .db!.insert(schema.sources)
      .values({ ...common, kind: 'web', accessedAt: 1 })
      .run()
  return () => state.sqlite!.prepare(`UPDATE ${kind === 'note' ? 'notes' : 'sources'} SET ai_excluded=1 WHERE id=?`).run(common.id)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2030-01-01T10:00:00Z').getTime() + day++ * 86_400_000)
  state.sqlite = new Database(':memory:')
  state.sqlite.loadExtension(getLoadablePath())
  state.db = drizzle(state.sqlite, { schema })
  migrate(state.db, { migrationsFolder: 'resources/migrations' })
  for (const fn of state.searches.values()) fn.mockReset()
  state.providers.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  state.sqlite?.close()
  state.sqlite = null
  state.db = null
  vi.useRealTimers()
})

describe('retrieval gateway', () => {
  it('routes DeepSeek as a preferred service and falls back without changing existing language defaults', async () => {
    const { searchWeb } = await import('../gateway')
    for (const id of ['bocha', 'deepseek'] as const) {
      saveBackend({ id, key: 'synthetic', enabled: true })
      state.searches.get(id)!.mockResolvedValue([result(id)])
    }
    expect((await run(() => searchWeb('中文默认次序'))).backend).toBe('bocha')
    setSettings({ retrieval: { preferZh: 'deepseek', preferEn: 'deepseek' } })
    expect((await run(() => searchWeb('中文首选搜索'))).backend).toBe('deepseek')
    expect((await run(() => searchWeb('English preferred search'))).backend).toBe('deepseek')
    state.searches.get('deepseek')!.mockResolvedValue([])
    expect((await run(() => searchWeb('中文空结果回退'))).backend).toBe('bocha')
  })
  it('cancels a queued DeepSeek request when its referenced provider key changes', async () => {
    const { searchWeb, retrievalStatus } = await import('../gateway')
    state.providers.set('official', { kind: 'deepseek', baseUrl: 'https://api.deepseek.com', updatedAt: 1 })
    saveBackend({ id: 'deepseek', keyProviderId: 'official', enabled: true })
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let sent = false
    state.searches.get('deepseek')!.mockImplementation(async (_query, _credential, signal: AbortSignal) => {
      await waiting
      signal.throwIfAborted()
      sent = true
      return [result('deepseek')]
    })
    const pending = run(() => searchWeb('public key rotation query'))
    state.providers.set('official', { kind: 'deepseek', baseUrl: 'https://api.deepseek.com', updatedAt: 2 })
    emit('retrieval:changed', {})
    release()
    await expect(pending).rejects.toThrow('联网搜索暂时失败')
    expect(sent).toBe(false)
    expect(state.sqlite!.prepare('SELECT COUNT(*) AS n FROM web_search_cache').get()).toEqual({ n: 0 })
    expect(retrievalStatus().backends.find((s) => s.id === 'deepseek')?.pausedUntil).toBeNull()
  })
  it('does not send a fallback to DeepSeek if the user disabled it while the first backend was running', async () => {
    const { searchWeb } = await import('../gateway')
    for (const id of ['bocha', 'deepseek'] as const) saveBackend({ id, key: 'synthetic', enabled: true })
    state.searches.get('bocha')!.mockImplementation(async () => {
      saveBackend({ id: 'deepseek', enabled: false })
      throw new Error('controlled failure')
    })
    state.searches.get('deepseek')!.mockResolvedValue([result('deepseek')])
    await expect(run(() => searchWeb('中文等待回退'))).rejects.toThrow('联网搜索暂时失败')
    expect(state.searches.get('deepseek')).not.toHaveBeenCalled()
    expect(state.sqlite!.prepare('SELECT COUNT(*) AS n FROM web_search_cache').get()).toEqual({ n: 0 })
  })
  it('keeps a valid search running when provider metadata changes without changing its key or official destination', async () => {
    const { searchWeb } = await import('../gateway')
    const provider = { kind: 'deepseek', baseUrl: 'https://api.deepseek.com', key: 'stable-synthetic-key', updatedAt: 1 }
    state.providers.set('official', provider)
    saveBackend({ id: 'deepseek', keyProviderId: 'official', enabled: true })
    state.searches.get('deepseek')!.mockImplementation(async () => {
      state.providers.set('official', { ...provider, updatedAt: 2 })
      emit('retrieval:changed', {})
      return [result('deepseek')]
    })
    expect((await run(() => searchWeb('public unchanged credential search'))).backend).toBe('deepseek')
  })
  it('rejects a disallowed purpose before any backend is touched', async () => {
    const { searchWeb } = await import('../gateway')
    await expect(searchWeb('controlled')).rejects.toThrow('这个功能不使用联网')
    expect([...state.searches.values()].every((f) => !f.mock.calls.length)).toBe(true)
  })
  it('routes Chinese and English queries, honors preferences and puts unsupported site filters last', async () => {
    const { searchWeb } = await import('../gateway')
    for (const id of ['bocha', 'tavily', 'brave'] as const) {
      saveBackend({ id, key: 'synthetic', enabled: true })
      state.searches.get(id)!.mockResolvedValue([result(id)])
    }
    expect((await run(() => searchWeb('中文知识查询'))).backend).toBe('bocha')
    expect((await run(() => searchWeb('english controlled evidence'))).backend).toBe('tavily')
    expect((await run(() => searchWeb('𠀀𠀁abcd'))).backend).toBe('bocha')
    setSettings({ retrieval: { preferEn: 'brave' } })
    expect((await run(() => searchWeb('another english query'))).backend).toBe('brave')
    expect((await run(() => searchWeb('中文限定网站', { site: 'example.org' }))).backend).toBe('tavily')
  })
  it('falls back through errors and empty responses, then pauses after three consecutive failures', async () => {
    const { searchWeb, retrievalStatus } = await import('../gateway')
    const { BackendError } = await import('../backends/common')
    for (const id of ['bocha', 'tavily', 'brave'] as const) saveBackend({ id, key: 'synthetic', enabled: true })
    state.searches.get('bocha')!.mockRejectedValue(new BackendError({ status: 500, retryable: true }))
    state.searches.get('tavily')!.mockResolvedValue([])
    state.searches.get('brave')!.mockResolvedValue([result('brave')])
    for (let i = 0; i < 3; i++) expect((await run(() => searchWeb(`中文查询${i}`))).backend).toBe('brave')
    expect(retrievalStatus().backends.find((s) => s.id === 'bocha')?.pausedUntil).toBe(Date.now() + 600_000)
    await run(() => searchWeb('中文第四个查询'))
    expect(state.searches.get('bocha')!.mock.calls).toHaveLength(3)
    expect(state.sqlite!.prepare('SELECT COUNT(*) AS n FROM retrieval_calls WHERE cached=0').get()).toEqual({ n: 11 })
  })
  it('pauses authentication failures for thirty minutes and clears consecutive failures after success', async () => {
    const { searchWeb, retrievalStatus } = await import('../gateway')
    const { BackendError } = await import('../backends/common')
    for (const id of ['bocha', 'tavily'] as const) saveBackend({ id, key: 'synthetic', enabled: true })
    state.searches.get('bocha')!.mockRejectedValueOnce(new BackendError({ status: 401, retryable: false }))
    state.searches.get('tavily')!.mockResolvedValue([result('tavily')])
    await run(() => searchWeb('认证失败测试'))
    expect(retrievalStatus().backends.find((s) => s.id === 'bocha')?.pausedUntil).toBe(Date.now() + 1_800_000)
    vi.setSystemTime(Date.now() + 1_800_001)
    state.searches.get('bocha')!.mockResolvedValueOnce([result('bocha')])
    await run(() => searchWeb('成功清零测试'))
    state.searches.get('bocha')!.mockRejectedValue(new BackendError({ status: 500, retryable: true }))
    await run(() => searchWeb('成功后一次失败'))
    expect(retrievalStatus().backends.find((s) => s.id === 'bocha')?.pausedUntil).toBeNull()
  })
  it('caches normalized queries, records cache hits and allows cached use at the daily limit', async () => {
    const { searchWeb } = await import('../gateway')
    saveBackend({ id: 'bocha', key: 'synthetic', enabled: true })
    state.searches.get('bocha')!.mockResolvedValue([result('bocha')])
    setSettings({ retrieval: { dailyLimit: 10 } })
    await run(() => searchWeb(' 中文\n学习  ', { freshness: 'day' }))
    for (let i = 0; i < 9; i++) await run(() => searchWeb(`其他中文学习${i}`))
    const cached = await run(() => searchWeb('中文 学习', { freshness: 'day' }))
    expect(cached.results).toHaveLength(1)
    expect(state.searches.get('bocha')!.mock.calls).toHaveLength(10)
    expect(state.sqlite!.prepare('SELECT COUNT(*) AS n FROM retrieval_calls WHERE cached=1').get()).toEqual({ n: 1 })
    await expect(run(() => searchWeb('超额中文问题'))).rejects.toThrow('10')
    vi.setSystemTime(Date.now() + 3_600_001)
    await expect(run(() => searchWeb('中文 学习', { freshness: 'day' }))).rejects.toThrow('10')
  })
  it.each([
    ['day', 3_600_000],
    ['week', 21_600_000],
    ['month', 86_400_000],
    ['year', 86_400_000],
    [undefined, 604_800_000]
  ] as const)('uses freshness %s cache lifetime', async (freshness, ttl) => {
    const { searchWeb } = await import('../gateway')
    saveBackend({ id: 'bocha', key: 'synthetic', enabled: true })
    state.searches.get('bocha')!.mockResolvedValue([result('bocha')])
    await run(() => searchWeb('缓存有效期', { freshness }))
    expect(state.sqlite!.prepare('SELECT expires_at-created_at AS ttl FROM web_search_cache').get()).toEqual({ ttl })
  })
  it('does not write incognito or empty search caches, and news expires in an hour', async () => {
    const { searchWeb } = await import('../gateway')
    saveBackend({ id: 'bocha', key: 'synthetic', enabled: true })
    state.searches.get('bocha')!.mockResolvedValue([result('bocha')])
    await run(() => searchWeb('无痕检索', { incognito: true }))
    expect(state.sqlite!.prepare('SELECT COUNT(*) AS n FROM web_search_cache').get()).toEqual({ n: 0 })
    state.searches.get('bocha')!.mockResolvedValue([])
    expect((await run(() => searchWeb('没有命中'))).results).toEqual([])
    expect(state.sqlite!.prepare('SELECT COUNT(*) AS n FROM web_search_cache').get()).toEqual({ n: 0 })
    state.searches.get('bocha')!.mockResolvedValue([result('bocha')])
    await run(() => searchWeb('新闻检索', { type: 'news' }))
    expect(state.sqlite!.prepare('SELECT expires_at-created_at AS ttl FROM web_search_cache').get()).toEqual({ ttl: 3_600_000 })
  })
  it('blocks excluded content and checks guards without exposing the query in the error', async () => {
    const { searchWeb } = await import('../gateway')
    saveBackend({ id: 'bocha', key: 'synthetic', enabled: true })
    state
      .db!.insert(schema.notes)
      .values({
        id: 'excluded',
        title: '私密标题',
        plainText: '独一无二的保密内容不能发送出去',
        aiExcluded: true,
        learnedAt: 1,
        editedAt: 1,
        createdAt: 1,
        updatedAt: 1
      })
      .run()
    await expect(run(() => searchWeb('搜索独一无二的保密内容不'))).rejects.toThrow('已拦截')
    await expect(
      run(() =>
        searchWeb('正常学习', {
          guard: () => {
            throw new Error('guard denied')
          }
        })
      )
    ).rejects.toThrow('guard denied')
    expect(state.searches.get('bocha')!.mock.calls).toHaveLength(0)
  })
  it.each(['note', 'source'] as const)('rechecks %s exclusion before sending a fallback query', async (kind) => {
    const { searchWeb } = await import('../gateway')
    const { BackendError } = await import('../backends/common')
    const exclude = dynamicPrivateContent(kind)
    for (const id of ['bocha', 'tavily'] as const) saveBackend({ id, key: 'synthetic', enabled: true })
    state.searches.get('bocha')!.mockImplementation(async () => {
      exclude()
      throw new BackendError({ status: 500, retryable: true })
    })
    state.searches.get('tavily')!.mockResolvedValue([result('tavily')])
    await expect(run(() => searchWeb('动态保密查询标题'))).rejects.toThrow('已拦截')
    expect(state.searches.get('tavily')!.mock.calls).toHaveLength(0)
    expect(state.sqlite!.prepare('SELECT COUNT(*) AS n FROM retrieval_calls WHERE cached=0').get()).toEqual({ n: 1 })
  })
  it('does not cache or return a response after its query becomes excluded', async () => {
    const { searchWeb } = await import('../gateway')
    const exclude = dynamicPrivateContent()
    saveBackend({ id: 'bocha', key: 'synthetic', enabled: true })
    state.searches.get('bocha')!.mockImplementation(async () => {
      exclude()
      return [result('bocha')]
    })
    await expect(run(() => searchWeb('动态保密查询标题'))).rejects.toThrow('已拦截')
    expect(state.sqlite!.prepare('SELECT COUNT(*) AS n FROM web_search_cache').get()).toEqual({ n: 0 })
  })
  it('cancels an attempt waiting to send when exclusion changes and releases its event subscriptions', async () => {
    const { searchWeb } = await import('../gateway')
    const privacy = await import('../privacyGuard')
    const check = vi.spyOn(privacy, 'check')
    const exclude = dynamicPrivateContent()
    saveBackend({ id: 'bocha', key: 'synthetic', enabled: true })
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let sent = false
    state.searches.get('bocha')!.mockImplementation(async (_query, _credential, signal: AbortSignal) => {
      await waiting
      signal.throwIfAborted()
      sent = true
      return [result('bocha')]
    })
    const pending = run(() => searchWeb('动态保密查询标题'))
    exclude()
    emit('notes:changed', { ids: ['dynamic-private'] })
    release()
    await expect(pending).rejects.toThrow('已拦截')
    expect(sent).toBe(false)
    const checksAfterRequest = check.mock.calls.length
    emit('notes:changed', { ids: ['dynamic-private'] })
    expect(check.mock.calls).toHaveLength(checksAfterRequest)
    check.mockRestore()
  })
  it('propagates privacy denial from academic concurrency instead of returning another backend response', async () => {
    const { searchAcademic } = await import('../gateway')
    const exclude = dynamicPrivateContent('note', 'alpha beta gamma delta')
    for (const id of ['openalex', 'semanticscholar', 'arxiv'] as const)
      state.searches.get(id)!.mockImplementation(async () => {
        exclude()
        return [result(id)]
      })
    await expect(run(() => searchAcademic('alpha beta gamma delta'))).rejects.toThrow('已拦截')
    expect(state.sqlite!.prepare('SELECT COUNT(*) AS n FROM web_search_cache').get()).toEqual({ n: 0 })
  })
  it('merges academic results by URL, DOI and title, keeps richer metadata and tolerates partial failure', async () => {
    const { searchAcademic } = await import('../gateway')
    state.searches
      .get('openalex')!
      .mockResolvedValue([{ ...result('openalex', 1, 'https://doi.org/10.1234/demo'), doi: '10.1234/demo', title: 'A study' }])
    state.searches.get('semanticscholar')!.mockResolvedValue([
      {
        ...result('semanticscholar', 2, 'https://scholar.example/paper'),
        doi: '10.1234/DEMO',
        title: 'A Study!',
        citations: 50,
        pdfUrl: 'https://paper.example/doc.pdf'
      }
    ])
    state.searches.get('arxiv')!.mockRejectedValue(new Error('raw sensitive error'))
    const found = await run(() => searchAcademic('English controlled study'))
    expect(found.results).toHaveLength(1)
    expect(found.results[0]).toMatchObject({ citations: 50, pdfUrl: 'https://paper.example/doc.pdf', rank: 1 })
    expect(state.sqlite!.prepare('SELECT expires_at-created_at AS ttl FROM web_search_cache LIMIT 1').get()).toEqual({ ttl: 2_592_000_000 })
    setSettings({ retrieval: { academic: false } })
    expect(await run(() => searchAcademic('Another paper'))).toEqual({ results: [], backends: [] })
  })
  it('reserves simultaneous requests so academic concurrency cannot exceed the daily limit', async () => {
    const { searchAcademic } = await import('../gateway')
    setSettings({ retrieval: { dailyLimit: 10 } })
    for (let i = 0; i < 9; i++)
      state
        .db!.insert(schema.retrievalCalls)
        .values({
          id: `call-${i}`,
          at: Date.now(),
          date: localDate(),
          backend: 'reader',
          kind: 'fetch',
          purpose: 'chat',
          ok: true,
          cached: false
        })
        .run()
    for (const id of ['openalex', 'semanticscholar', 'arxiv'] as const) state.searches.get(id)!.mockResolvedValue([result(id)])
    await run(() => searchAcademic('English final call'))
    expect(['openalex', 'semanticscholar', 'arxiv'].reduce((n, id) => n + state.searches.get(id)!.mock.calls.length, 0)).toBe(1)
  })
  it('tests an explicitly configured disabled backend without a cache, safely and under search.test', async () => {
    const { testBackend } = await import('../gateway')
    saveBackend({ id: 'bocha', key: 'synthetic', enabled: false })
    state.searches.get('bocha')!.mockResolvedValue([result('bocha')])
    expect(await testBackend('bocha')).toMatchObject({ ok: true })
    expect(state.sqlite!.prepare('SELECT purpose FROM retrieval_calls').get()).toEqual({ purpose: 'search.test' })
    expect(state.sqlite!.prepare('SELECT COUNT(*) AS n FROM web_search_cache').get()).toEqual({ n: 0 })
    expect(BACKEND_IDS).toHaveLength(11)
  })
})
