import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getLoadablePath } from 'sqlite-vec'
import type { DB } from '../../../db'
import * as schema from '../../../db/knowledgeSchema'

const context = vi.hoisted(() => ({ db: null as DB | null, sqlite: null as Database.Database | null }))
vi.mock('../../../db', () => ({ getDb: () => context.db, getSqlite: () => context.sqlite }))
vi.mock('../../../events', () => ({ emit: vi.fn() }))
vi.mock('electron', () => ({ app: { getLocale: () => 'en' }, nativeTheme: {} }))
import { cleanupRetrieval, clearRetrievalCache } from '../maintenance'
import { retrievalUsage, recordCall, reserveCall } from '../calls'
import { withRun } from '../../agent/context'
import { localDate } from '../../stats'
import { setSettings } from '../../settings'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2030-03-15T10:00:00Z'))
  context.sqlite = new Database(':memory:')
  context.sqlite.loadExtension(getLoadablePath())
  context.db = drizzle(context.sqlite, { schema })
  migrate(context.db, { migrationsFolder: 'resources/migrations' })
})
afterEach(() => {
  context.sqlite!.close()
  context.db = null
  context.sqlite = null
  vi.useRealTimers()
})
const page = (id: string, fetchedAt: number): void => {
  context
    .db!.insert(schema.webPages)
    .values({
      id,
      url: `https://fixture.example/${id}`,
      finalUrl: `https://fixture.example/${id}`,
      title: 'Snapshot',
      fetchedAt,
      method: 'fetch',
      text: 'Visible controlled paragraph.',
      textHash: id
    })
    .run()
}

describe('retrieval maintenance and accounting', () => {
  it('clears unreferenced snapshots and searches while preserving referenced evidence', () => {
    page('referenced', 1)
    page('unreferenced', 1)
    context
      .db!.insert(schema.webPageRefs)
      .values({ pageId: 'referenced', messageId: 'message', conversationId: 'conv', createdAt: 1 })
      .run()
    context
      .db!.insert(schema.webSearchCache)
      .values({ key: 'cache', backend: 'bocha', results: '[]', createdAt: 1, expiresAt: Date.now() + 10000 })
      .run()
    expect(clearRetrievalCache()).toEqual({ searches: 1, pages: 1 })
    expect(context.sqlite!.prepare('SELECT id FROM web_pages').all()).toEqual([{ id: 'referenced' }])
  })
  it('prunes expired entries, caps search caches at 5000, and maintains only once each day', () => {
    const insert = context.sqlite!.prepare('INSERT INTO web_search_cache VALUES (?, ?, ?, ?, ?)')
    context.sqlite!.transaction(() => {
      for (let i = 0; i < 5002; i++) insert.run(`key-${i}`, 'bocha', '[]', i, Date.now() + 10000)
      insert.run('expired', 'bocha', '[]', 6000, Date.now() - 1)
    })()
    page('old-unreferenced', 1)
    page('old-referenced', 1)
    page('recent', Date.now())
    context
      .db!.insert(schema.webPageRefs)
      .values({ pageId: 'old-referenced', messageId: 'message', conversationId: 'conv', createdAt: 1 })
      .run()
    recordCall('bocha', 'search', true, false, Date.now())
    context.sqlite!.prepare('UPDATE retrieval_calls SET at=?').run(Date.now() - 400 * 86_400_000 - 1)
    cleanupRetrieval()
    expect(context.sqlite!.prepare('SELECT COUNT(*) AS n FROM web_search_cache').get()).toEqual({ n: 5000 })
    expect(context.sqlite!.prepare('SELECT key FROM web_search_cache WHERE key IN (?, ?, ?)').all('expired', 'key-0', 'key-1')).toEqual([])
    expect(context.sqlite!.prepare('SELECT id FROM web_pages ORDER BY id').all()).toEqual([{ id: 'old-referenced' }, { id: 'recent' }])
    expect(context.sqlite!.prepare('SELECT COUNT(*) AS n FROM retrieval_calls').get()).toEqual({ n: 0 })
    page('late-old', 1)
    cleanupRetrieval()
    expect(context.sqlite!.prepare('SELECT id FROM web_pages WHERE id=?').get('late-old')).toEqual({ id: 'late-old' })
    vi.setSystemTime(Date.now() + 86_400_000)
    cleanupRetrieval()
    expect(context.sqlite!.prepare('SELECT id FROM web_pages WHERE id=?').get('late-old')).toBeUndefined()
  })
  it('counts cache hits and failed requests, groups services, and releases reserved quota', () => {
    withRun({ purpose: 'workspace', conversationId: 'conv' }, () => {
      recordCall('bocha', 'search', true, false, Date.now() - 100)
      recordCall('bocha', 'search', true, true, Date.now())
      recordCall('reader', 'render', false, false, Date.now())
    })
    expect(retrievalUsage('today')).toEqual({
      range: 'today',
      total: 3,
      cached: 1,
      failed: 1,
      byBackend: [
        { backend: 'bocha', calls: 2 },
        { backend: 'reader', calls: 1 }
      ]
    })
    expect(context.sqlite!.prepare('SELECT DISTINCT purpose, conversation_id, date FROM retrieval_calls').all()).toEqual([
      { purpose: 'workspace', conversation_id: 'conv', date: localDate() }
    ])
    setSettings({ retrieval: { dailyLimit: 10 } })
    const releases = Array.from({ length: 8 }, () => reserveCall())
    expect(() => reserveCall()).toThrow('10')
    releases[0]()
    releases[0]()
    const last = reserveCall()
    last()
    releases.forEach((release) => release())
  })
})
