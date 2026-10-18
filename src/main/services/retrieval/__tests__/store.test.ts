import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getLoadablePath } from 'sqlite-vec'
import type { DB } from '../../../db'
import * as schema from '../../../db/knowledgeSchema'

const context = vi.hoisted(() => ({
  db: null as DB | null,
  sqlite: null as Database.Database | null,
  providers: new Map<string, { kind: string; usable: boolean; baseUrl?: string; updatedAt?: number }>()
}))
vi.mock('../../../db', () => ({ getDb: () => context.db, getSqlite: () => context.sqlite }))
vi.mock('../../../events', () => ({ emit: vi.fn() }))
vi.mock('electron', () => ({ app: { getLocale: () => 'zh-CN' }, nativeTheme: {} }))
vi.mock('../../mcp/secrets', () => ({
  sealJson: (v: unknown) => Buffer.from('sealed:' + Buffer.from(JSON.stringify(v)).toString('base64')),
  openJson: (b: Buffer | null, fallback: unknown) => (b ? JSON.parse(Buffer.from(b.toString().slice(7), 'base64').toString()) : fallback)
}))
vi.mock('../../ai/providers', () => ({
  getProviderRow: (id: string) => {
    const row = context.providers.get(id)
    if (!row) throw new Error('Not found')
    return row
  },
  decryptKey: (row: { usable: boolean }) => (row.usable ? 'synthetic-provider-key' : null)
}))

beforeEach(() => {
  const sqlite = new Database(':memory:')
  sqlite.loadExtension(getLoadablePath())
  context.sqlite = sqlite
  context.db = drizzle(sqlite, { schema })
  migrate(context.db, { migrationsFolder: 'resources/migrations' })
  context.providers.clear()
})
afterEach(() => {
  context.sqlite?.close()
  context.db = null
  context.sqlite = null
})

describe('search backend state and upgrade', () => {
  it('reuses only an official DeepSeek provider key and revokes the reference when its destination changes', async () => {
    const store = await import('../backends/store')
    context.providers.set('deepseek-provider', { kind: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', usable: true, updatedAt: 1 })
    store.saveBackend({ id: 'deepseek', keyProviderId: 'deepseek-provider', enabled: true })
    expect(store.backendStates().find((s) => s.id === 'deepseek')).toMatchObject({ keySet: true, keyProviderId: 'deepseek-provider' })
    expect(store.credentialsFor('deepseek').key).toBe('synthetic-provider-key')
    expect(context.sqlite!.prepare('SELECT key_enc FROM search_backends WHERE id=?').get('deepseek')).toEqual({ key_enc: null })
    context.providers.set('deepseek-provider', { kind: 'deepseek', baseUrl: 'https://third-party.example/v1', usable: true, updatedAt: 2 })
    expect(store.credentialsFor('deepseek').key).toBeNull()
    expect(store.backendStates().find((s) => s.id === 'deepseek')?.keySet).toBe(false)
    expect(() => store.saveBackend({ id: 'deepseek', keyProviderId: 'deepseek-provider', enabled: true })).toThrow()
    store.saveBackend({ id: 'deepseek', keyProviderId: null, key: 'synthetic-own-key', enabled: true })
    expect(store.credentialsFor('deepseek').key).toBe('synthetic-own-key')
  })
  it('copies legacy encrypted rows exactly once and never overwrites a new configuration', async () => {
    const store = await import('../backends/store')
    context
      .db!.insert(schema.searchConnections)
      .values([
        { service: 'bocha', keyEnc: Buffer.from('old-ciphertext'), enabled: true, updatedAt: 7 },
        { service: 'tavily', keyEnc: Buffer.from('old-tavily-ciphertext'), enabled: false, updatedAt: 8 }
      ])
      .run()
    context
      .db!.insert(schema.searchBackends)
      .values({ id: 'bocha', keyEnc: Buffer.from('new-ciphertext'), enabled: false, updatedAt: 9 })
      .run()
    store.migrateSearchConnections()
    expect(context.sqlite!.prepare('SELECT key_enc, enabled, updated_at FROM search_backends WHERE id=?').get('bocha')).toEqual({
      key_enc: Buffer.from('new-ciphertext'),
      enabled: 0,
      updated_at: 9
    })
    expect(context.sqlite!.prepare('SELECT key_enc, enabled, updated_at FROM search_backends WHERE id=?').get('tavily')).toEqual({
      key_enc: Buffer.from('old-tavily-ciphertext'),
      enabled: 0,
      updated_at: 8
    })
    context
      .db!.insert(schema.searchConnections)
      .values({ service: 'brave', keyEnc: Buffer.from('late-ciphertext'), enabled: true, updatedAt: 10 })
      .run()
    store.migrateSearchConnections()
    expect(context.sqlite!.prepare('SELECT id FROM search_backends WHERE id=?').get('brave')).toBeUndefined()
    expect(context.sqlite!.prepare('SELECT COUNT(*) AS n FROM search_connections').get()).toEqual({ n: 3 })
  })
  it('clears a paused backend when the user saves a new configuration', async () => {
    const store = await import('../backends/store')
    const breaker = await import('../breaker')
    breaker.failures.set('bocha', 3)
    breaker.pauses.set('bocha', Date.now() + 1_800_000)
    expect(store.backendStates(breaker.pauses).find((s) => s.id === 'bocha')!.pausedUntil).not.toBeNull()
    store.saveBackend({ id: 'bocha', key: 'new-synthetic-key', enabled: true })
    expect(breaker.failures.has('bocha')).toBe(false)
    expect(store.backendStates(breaker.pauses).find((s) => s.id === 'bocha')!.pausedUntil).toBeNull()
  })
  it('keeps multiple backends enabled, preserves an omitted key and never exposes it in states', async () => {
    const store = await import('../backends/store')
    store.saveBackend({ id: 'bocha', key: 'synthetic-bocha-key', enabled: true })
    store.saveBackend({ id: 'tavily', key: 'synthetic-tavily-key', enabled: true })
    store.saveBackend({ id: 'bocha', enabled: true })
    const states = store.backendStates()
    expect(states.filter((s) => s.kind === 'web' && s.enabled).map((s) => s.id)).toEqual(['bocha', 'tavily'])
    expect(store.credentialsFor('bocha').key).toBe('synthetic-bocha-key')
    expect(JSON.stringify(states)).not.toContain('synthetic-')
    store.saveBackend({ id: 'bocha', key: '', enabled: false })
    expect(store.backendStates().find((s) => s.id === 'bocha')).toMatchObject({ keySet: false, enabled: false })
    expect(() => store.saveBackend({ id: 'bocha', enabled: true })).toThrow()
  })
  it('validates a Zhipu provider reference and falls back safely if it disappears', async () => {
    const store = await import('../backends/store')
    context.providers.set('wrong', { kind: 'ollama', usable: true })
    expect(() => store.saveBackend({ id: 'zhipu', keyProviderId: 'wrong', enabled: true })).toThrow()
    context.providers.set('zhipu-provider', { kind: 'zhipu', usable: true })
    store.saveBackend({ id: 'zhipu', keyProviderId: 'zhipu-provider', enabled: true })
    expect(store.backendStates().find((s) => s.id === 'zhipu')).toMatchObject({ keySet: true, keyProviderId: 'zhipu-provider' })
    expect(context.sqlite!.prepare('SELECT key_enc FROM search_backends WHERE id=?').get('zhipu')).toEqual({ key_enc: null })
    context.providers.clear()
    expect(store.backendStates().find((s) => s.id === 'zhipu')?.keySet).toBe(false)
  })
  it.each([
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com/?query=x',
    'https://example.com/#hash',
    'file:///tmp/search'
  ])('rejects unsafe SearXNG instance %s', async (baseUrl) => {
    const store = await import('../backends/store')
    expect(() => store.saveBackend({ id: 'searxng', baseUrl, enabled: true })).toThrow()
  })
  it.each([
    'https://search.example.com',
    'http://localhost:8888',
    'http://127.0.0.1:8888',
    'http://[::1]:8888',
    'http://search.local',
    'http://10.1.2.3',
    'http://172.16.2.3',
    'http://192.168.1.2'
  ])('accepts a safe SearXNG instance %s', async (baseUrl) => {
    const store = await import('../backends/store')
    store.saveBackend({ id: 'searxng', baseUrl, enabled: true })
    expect(store.backendStates().find((s) => s.id === 'searxng')).toMatchObject({ enabled: true })
  })
  it('merges a saved retrieval settings patch and retains all defaults across reads', async () => {
    const { getSettings, setSettings } = await import('../../settings')
    expect(getSettings().retrieval).toMatchObject({ mode: 'auto', academic: true, dailyLimit: 300 })
    setSettings({ retrieval: { cautious: true, trustedSites: ['example.org'] } })
    setSettings({ retrieval: { dailyLimit: 25 } })
    expect(getSettings().retrieval).toEqual({
      cloudReader: false,
      autoUpgrade: true,
      mode: 'auto',
      preferZh: null,
      preferEn: null,
      academic: true,
      cautious: true,
      dailyLimit: 25,
      trustedSites: ['example.org'],
      lowTrustSites: []
    })
  })
})
