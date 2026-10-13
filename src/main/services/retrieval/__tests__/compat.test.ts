import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getLoadablePath } from 'sqlite-vec'
import type { DB } from '../../../db'
import type { WebResult } from '@shared/retrieval'
import { setMessageLanguage } from '../../../lib/messages'
import { assertWebAllowed, WebPolicyError } from '../policy'
import { withRun } from '../../agent/context'
import * as schema from '../../../db/knowledgeSchema'

const fixture = vi.hoisted(() => ({
  db: null as DB | null,
  sqlite: null as Database.Database | null,
  available: false,
  results: [] as WebResult[],
  searchWeb: vi.fn(),
  testBackend: vi.fn()
}))
vi.mock('../../../db', () => ({ getDb: () => fixture.db, getSqlite: () => fixture.sqlite }))
vi.mock('../../../events', () => ({ emit: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: false, getLocale: () => 'en' }, nativeTheme: {} }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../mcp/secrets', () => ({
  sealJson: (value: unknown) => Buffer.from('fixture-sealed:' + JSON.stringify(value)),
  openJson: (value: Buffer | null, fallback: unknown) => (value ? JSON.parse(value.toString().slice(15)) : fallback)
}))
vi.mock('../../ai/providers', () => ({ getProviderRow: vi.fn(), decryptKey: vi.fn() }))
vi.mock('../../discover/feeds', () => ({ discoverChanged: vi.fn(), checkDiscoverUrl: vi.fn() }))
// 兼容单测只替代网关边界；真实网关/HTTP 的调用入口由 purposeProbe 单独覆盖。
vi.mock('../gateway', () => ({
  hasWebBackend: () => fixture.available,
  searchWeb: fixture.searchWeb,
  testBackend: fixture.testBackend
}))
import * as compat from '../../discover/search'

beforeEach(() => {
  const sqlite = new Database(':memory:')
  sqlite.loadExtension(getLoadablePath())
  fixture.sqlite = sqlite
  fixture.db = drizzle(sqlite, { schema })
  migrate(fixture.db, { migrationsFolder: 'resources/migrations' })
  fixture.available = false
  fixture.results = []
  fixture.searchWeb.mockReset().mockImplementation(async () => {
    assertWebAllowed()
    return { results: fixture.results, backend: fixture.results[0]?.backend ?? null }
  })
  fixture.testBackend.mockReset().mockResolvedValue({ ok: true, message: 'Connection succeeded' })
  setMessageLanguage('en')
})
afterEach(() => {
  fixture.sqlite?.close()
  fixture.db = null
  fixture.sqlite = null
  setMessageLanguage('zh-CN')
})

describe('legacy discovery search compatibility', () => {
  it('retains exactly the five existing exports', () => {
    expect(Object.keys(compat).sort()).toEqual(['hasSearch', 'search', 'searchProviders', 'searchSave', 'searchTest'])
  })
  it('projects only the three legacy connections from new backend state', () => {
    fixture
      .db!.insert(schema.searchBackends)
      .values([
        { id: 'bocha', enabled: true, keyEnc: Buffer.from('fixture-marker'), updatedAt: 1 },
        { id: 'brave', enabled: false, keyEnc: Buffer.from('fixture-marker'), updatedAt: 1 },
        { id: 'searxng', enabled: true, baseUrl: 'https://search.example', updatedAt: 1 }
      ])
      .run()
    fixture
      .db!.insert(schema.searchConnections)
      .values({ service: 'tavily', enabled: true, keyEnc: Buffer.from('legacy-marker'), updatedAt: 1 })
      .run()
    expect(compat.searchProviders()).toEqual([
      { service: 'bocha', keySet: true, enabled: true },
      { service: 'tavily', keySet: false, enabled: false },
      { service: 'brave', keySet: true, enabled: false }
    ])
  })
  it('saves several enabled services together and leaves legacy rows unchanged', () => {
    fixture
      .db!.insert(schema.searchConnections)
      .values({ service: 'bocha', enabled: false, keyEnc: Buffer.from('legacy-marker'), updatedAt: 1 })
      .run()
    const before = fixture.sqlite!.prepare('SELECT * FROM search_connections').all()
    for (const service of ['bocha', 'tavily', 'brave'] as const)
      compat.searchSave({ service, key: 'controlled-fixture-token', enabled: true })
    expect(compat.searchProviders().filter((connection) => connection.enabled)).toHaveLength(3)
    expect(fixture.db!.select().from(schema.searchBackends).all()).toHaveLength(3)
    expect(fixture.sqlite!.prepare('SELECT * FROM search_connections').all()).toEqual(before)
    expect(JSON.stringify(compat.searchProviders())).not.toContain('controlled-fixture-token')
  })
  it('preserves an omitted key and clears an explicitly empty key', () => {
    compat.searchSave({ service: 'bocha', key: 'controlled-fixture-token', enabled: true })
    compat.searchSave({ service: 'bocha', enabled: false })
    expect(compat.searchProviders()[0]).toEqual({ service: 'bocha', keySet: true, enabled: false })
    compat.searchSave({ service: 'bocha', key: '', enabled: false })
    expect(compat.searchProviders()[0]).toEqual({ service: 'bocha', keySet: false, enabled: false })
    expect(() => compat.searchSave({ service: 'bocha', enabled: true })).toThrow()
  })
  it('does not depend on the legacy table for reads or saves', () => {
    // 只在临时内存库移除表，用于证明包装从新配置读取；不会删除任何应用数据。
    fixture.sqlite!.exec('DROP TABLE search_connections')
    expect(() => compat.searchSave({ service: 'brave', key: 'controlled-fixture-token', enabled: true })).not.toThrow()
    expect(compat.searchProviders()[2]).toEqual({ service: 'brave', keySet: true, enabled: true })
  })
  it('reports availability through the new gateway, including nonlegacy services', () => {
    expect(compat.hasSearch()).toBe(false)
    fixture.available = true
    expect(compat.hasSearch()).toBe(true)
  })
  it('maps gateway results to the original JSON shape and forwards search options', async () => {
    fixture.results = [
      {
        url: 'https://search.example/result',
        title: 'Controlled result',
        snippet: 'Controlled snippet',
        publishedAt: 123,
        backend: 'tavily',
        rank: 1,
        site: 'search.example',
        content: 'Internal backend content',
        authors: ['Controlled Author']
      },
      {
        url: 'https://search.example/another',
        title: 'Another',
        snippet: 'Another snippet',
        backend: 'tavily',
        rank: 2
      }
    ]
    const guard = (): void => undefined,
      signal = new AbortController().signal
    const results = await withRun({ purpose: 'task' }, () =>
      compat.search('Controlled query', { count: 3, freshness: 'week', guard, signal })
    )
    expect(results).toEqual([
      { url: 'https://search.example/result', title: 'Controlled result', snippet: 'Controlled snippet', publishedAt: 123 },
      { url: 'https://search.example/another', title: 'Another', snippet: 'Another snippet' }
    ])
    expect(fixture.searchWeb).toHaveBeenCalledWith('Controlled query', {
      count: 3,
      freshness: 'week',
      guard,
      signal,
      legacyService: undefined
    })
  })
  it.each([
    [undefined, 8],
    [0, 1],
    [20, 10]
  ] as const)('preserves legacy count %s as %s', async (count, expected) => {
    await withRun({ purpose: 'task' }, () => compat.search('Controlled query', { count }))
    expect(fixture.searchWeb.mock.calls[0]?.[1]).toMatchObject({ count: expected })
  })
  it('forwards an explicitly selected service to the controlled compatibility gateway option', async () => {
    await withRun({ purpose: 'task' }, () => compat.search('Controlled query', { service: 'brave' }))
    expect(fixture.searchWeb.mock.calls[0]?.[1]).toMatchObject({ legacyService: 'brave', count: 8 })
  })
  it('returns no results through the gateway when no backend is configured', async () => {
    expect(await withRun({ purpose: 'task' }, () => compat.search('Controlled query'))).toEqual([])
    expect(fixture.searchWeb).toHaveBeenCalledTimes(1)
  })
  it('still enforces gateway policy when no backend is configured', async () => {
    await expect(withRun({ purpose: 'reflection' }, () => compat.search('Controlled query'))).rejects.toThrow(WebPolicyError)
    await expect(compat.search('Controlled query')).rejects.toThrow(WebPolicyError)
  })
  it.each([
    ['zh-CN', true, '搜索连接成功'],
    ['zh-CN', false, '搜索连接失败，请检查 Key 与网络'],
    ['en', true, 'Search connection succeeded'],
    ['en', false, 'Search connection failed; check key and network']
  ] as const)('preserves the legacy searchTest message in %s for ok=%s', async (language, ok, message) => {
    setMessageLanguage(language)
    fixture.testBackend.mockResolvedValue({ ok, message: 'Different new gateway wording' })
    expect(await compat.searchTest('brave')).toEqual({ ok, message })
    expect(fixture.testBackend).toHaveBeenCalledWith('brave')
    expect(fixture.searchWeb).not.toHaveBeenCalled()
  })
  it('sanitizes an unexpected diagnostic failure without returning its details', async () => {
    fixture.testBackend.mockRejectedValue(new Error('Controlled internal diagnostic failure'))
    expect(await compat.searchTest('bocha')).toEqual({ ok: false, message: 'Search connection failed; check key and network' })
  })
})
