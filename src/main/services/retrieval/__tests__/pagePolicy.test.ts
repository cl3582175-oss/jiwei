import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getLoadablePath } from 'sqlite-vec'
import type { DB } from '../../../db'
import * as schema from '../../../db/knowledgeSchema'

const state = vi.hoisted(() => ({
  db: null as DB | null,
  sqlite: null as Database.Database | null,
  packaged: true,
  blocked: [] as string[]
}))
vi.mock('../../../db', () => ({ getDb: () => state.db, getSqlite: () => state.sqlite }))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.packaged
    },
    getLocale: () => 'en'
  },
  nativeTheme: {}
}))
vi.mock('../../settings', () => ({ getSettings: () => ({ browser: { aiBlockedSites: state.blocked } }) }))
import { assertReadableUrl, isExcludedSourceUrl } from '../pagePolicy'
beforeEach(() => {
  state.sqlite = new Database(':memory:')
  state.sqlite.loadExtension(getLoadablePath())
  state.db = drizzle(state.sqlite, { schema })
  migrate(state.db, { migrationsFolder: 'resources/migrations' })
  state.packaged = true
  state.blocked = []
  vi.stubEnv('JIWEI_TEST_NETWORK', '')
})
afterEach(() => {
  state.sqlite?.close()
  state.db = null
  state.sqlite = null
  vi.unstubAllEnvs()
})
const source = (id: string, url: string, aiExcluded: boolean, deletedAt: number | null = null): void => {
  state
    .db!.insert(schema.sources)
    .values({ id, url, aiExcluded, title: 'Metadata only', kind: 'web', accessedAt: 1, createdAt: 1, updatedAt: 1, deletedAt })
    .run()
}
describe('page URL policy', () => {
  it('matches excluded source metadata through urlKey and reevaluates exclusion each time', () => {
    source('private', 'http://www.example.org/article/?utm_source=private&a=1', true)
    expect(isExcludedSourceUrl('https://example.org/article?a=1')).toBe(true)
    expect(() => assertReadableUrl('https://example.org/article?a=1')).toThrow()
    state.sqlite!.prepare('UPDATE sources SET ai_excluded=0 WHERE id=?').run('private')
    expect(isExcludedSourceUrl('https://example.org/article?a=1')).toBe(false)
    expect(() => assertReadableUrl('https://example.org/article?a=1')).not.toThrow()
  })
  it('does not load source assets/segments/bodies and treats known excluded tombstones conservatively', () => {
    source('excluded', 'https://example.org/old', true, 1)
    expect(isExcludedSourceUrl('https://example.org/old')).toBe(true)
    expect(state.db!.select().from(schema.sourceSegments).all()).toEqual([])
    source('allowed', 'https://example.org/allowed', false)
    expect(() => assertReadableUrl('https://example.org/allowed')).not.toThrow()
  })
  it.each([
    ['https://www.example.org/article', 'https://example.org./article'],
    ['http://www.example.org./article?utm_source=fixture', 'https://example.org/article']
  ])('treats excluded source %s and trailing-dot variant %s as the same destination', (stored, requested) => {
    source('excluded', stored, true)
    expect(isExcludedSourceUrl(requested)).toBe(true)
    expect(() => assertReadableUrl(requested)).toThrow()
  })
  it.each(['file:///tmp/private', 'javascript:alert(1)', 'data:text/plain,secret', 'https://user:pass@example.org/article', 'not a URL'])(
    'rejects invalid or credential-bearing URL %s',
    (url) => expect(() => assertReadableUrl(url)).toThrow()
  )
  it.each([
    'http://localhost',
    'http://localhost.',
    'https://sub.localhost./article',
    'https://sub.localhost/article',
    'http://127.0.0.1',
    'https://0.0.0.0',
    'http://2130706433',
    'http://10.1.2.3',
    'https://172.16.1.1',
    'https://192.168.1.1',
    'https://169.254.169.254',
    'https://100.64.1.1',
    'https://224.1.2.3',
    'https://[::1]',
    'https://[::]',
    'https://[fd00::1]',
    'https://[fe80::1]',
    'https://[::ffff:127.0.0.1]',
    'http://server.local',
    'http://server.local.',
    'http://intranet',
    'http://intranet.',
    'http://server.internal',
    'http://server.internal.'
  ])('rejects a private/local/reserved destination %s', (url) => expect(() => assertReadableUrl(url)).toThrow())
  it('permits only the three existing loopback hosts in explicit development network tests', () => {
    state.packaged = false
    expect(() => assertReadableUrl('http://localhost:9000/article')).toThrow()
    vi.stubEnv('JIWEI_TEST_NETWORK', '1')
    for (const url of ['http://localhost:9000/article', 'http://127.0.0.1:9000/article', 'http://[::1]:9000/article'])
      expect(() => assertReadableUrl(url)).not.toThrow()
    expect(() => assertReadableUrl('http://localhost.:9000/article')).toThrow()
    expect(() => assertReadableUrl('http://10.1.2.3/article')).toThrow()
    state.packaged = true
    expect(() => assertReadableUrl('http://localhost:9000/article')).toThrow()
  })
  it('rejects built-in sensitive sites and current user blocked subdomains', () => {
    expect(() => assertReadableUrl('https://mail.example.org/inbox')).toThrow()
    state.blocked = ['private.example.org']
    expect(() => assertReadableUrl('https://sub.private.example.org/read')).toThrow()
  })
  it('applies built-in and user blocked privacy rules to trailing-dot hosts', () => {
    expect(() => assertReadableUrl('https://paypal.com./payments')).toThrow()
    expect(() => assertReadableUrl('https://accounts.google.com./login')).toThrow()
    state.blocked = ['private.example.org']
    expect(() => assertReadableUrl('https://private.example.org./read')).toThrow()
    expect(() => assertReadableUrl('https://sub.private.example.org./read')).toThrow()
    state.blocked = ['private.example.org.']
    expect(() => assertReadableUrl('https://private.example.org/read')).toThrow()
  })
  it.each([
    'https://www.google.com/search?q=private',
    'https://www.google.co.uk/search?q=x',
    'https://www.baidu.com/s?wd=x',
    'https://cn.bing.com/search?q=x',
    'https://cn.bing.com./search?q=x',
    'https://duckduckgo.com/?q=x',
    'https://search.yahoo.com/search?p=x',
    'https://search.yahoo.com./search?p=x',
    'https://search.brave.com/search?q=x',
    'https://www.sogou.com/web?query=x',
    'https://www.so.com/s?q=x',
    'https://yandex.com/search/?text=x'
  ])('rejects a search engine result page %s', (url) => expect(() => assertReadableUrl(url)).toThrow())
  it.each([
    'https://developers.google.com/search/docs',
    'https://www.google.com/search/about',
    'https://baike.baidu.com/item/fixture',
    'https://api-dashboard.search.brave.com/documentation/web-search',
    'https://docs.example.org/article',
    'https://example.org/search?q=ordinary-site'
  ])('allows public documentation/encyclopedia and ordinary site pages %s', (url) => expect(() => assertReadableUrl(url)).not.toThrow())
})
