import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getLoadablePath } from 'sqlite-vec'
import * as schema from '../../../db/knowledgeSchema'
import type { DB } from '../../../db'
const env = vi.hoisted(() => ({ db: null as DB | null, blocked: [] as string[], requests: [] as RequestInit[] }))
vi.mock('electron', () => ({
  app: { isPackaged: false },
  net: {
    fetch: (url: string, options: RequestInit) => {
      env.requests.push(options)
      return fetch(url, options)
    }
  }
}))
vi.mock('../../../db', () => ({ getDb: () => env.db }))
vi.mock('../../settings', () => ({ getSettings: () => ({ browser: { aiBlockedSites: env.blocked } }) }))
vi.mock('../../agent/audit', () => ({ audit: vi.fn() }))
vi.mock('../../jobs', () => ({ enqueue: vi.fn(), registerJobKind: vi.fn(), cancelJob: vi.fn() }))
vi.mock('../../device', () => ({ deviceId: () => 'test' }))
vi.mock('../../../events', () => ({ emit: vi.fn() }))
vi.mock('../../../lib/messages', () => ({ tr: (_zh: string, en: string) => en }))
import { saveFeed, refreshFeed, listFeeds } from '../feeds'
import { fetchWebText } from '../../webText'
let db: Database.Database, server: Server, url: string, revision: number
beforeEach(async () => {
  db = new Database(':memory:')
  db.loadExtension(getLoadablePath())
  env.db = drizzle(db, { schema })
  migrate(env.db, { migrationsFolder: 'resources/migrations' })
  env.blocked = []
  env.requests = []
  revision = 1
  server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: 'https://blocked.example/list' }).end()
      return
    }
    res.setHeader('Content-Type', 'text/html')
    if (req.url === '/large') { res.end(`<html><body>${'Visible '.repeat(4000)}</body></html>`); return }
    res.end(
      `<html><head><title>Announcements</title></head><body><article><h1>Public announcements</h1><p>${'Institution information. '.repeat(40)}</p></article><nav><ul>${Array.from({ length: 15 }, (_, i) => `<li><a href="/article/${i}">Announcement ${i}: revision ${revision}</a> 2026-10-12</li>`).join('')}</ul></nav><script>SECRET_SCRIPT</script></body></html>`
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/list`
})
afterEach(async () => {
  await new Promise<void>((r, reject) => server.close((e) => (e ? reject(e) : r())))
  db.close()
})
it.each(['web', 'rss'] as const)(
  'monitors visible list through %s path, baseline sends no old items and a change creates one page snapshot',
  async (kind) => {
    const feed = saveFeed({ url, kind, title: 'List', enabled: true, goalId: null })
    await refreshFeed(feed.id)
    expect(db.prepare('select * from feed_items').all()).toHaveLength(0)
    expect(listFeeds()[0]).toMatchObject({ kind: 'web', error: null })
    revision = 2
    await refreshFeed(feed.id)
    const rows = db.prepare('select * from feed_items').all() as { summary: string; url: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].url).toBe(url)
    for (let i = 0; i < 15; i++) expect(rows[0].summary).toContain(`Announcement ${i}: revision 2`)
    expect(rows[0].summary).not.toContain('SECRET_SCRIPT')
    expect(env.requests.every((r) => r.credentials === 'omit' && r.redirect === 'manual')).toBe(true)
  },
  20000
)
it('retains redirect privacy and cancellation at the production fetch boundary', async () => {
  env.blocked = ['blocked.example']
  await expect(fetchWebText(url.replace('/list', '/redirect'), 'html')).rejects.toThrow(/excluded/)
  const c = new AbortController()
  c.abort()
  await expect(fetchWebText(url, 'html', c.signal)).rejects.toThrow()
}, 10000)
it('establishes a new visible-list baseline when upgrading an old Readability hash', async () => {
  const feed = saveFeed({ url, kind: 'web', title: 'List', enabled: true, goalId: null })
  db.prepare('update feeds set content_hash = ? where id = ?').run('old-readability-heading-hash', feed.id)
  await refreshFeed(feed.id)
  expect(db.prepare('select * from feed_items').all()).toHaveLength(0)
  expect(listFeeds()[0].error).toBeNull()
}, 10000)

it('retains the existing 20000-character cap for visible HTML', async () => {
  const page = await fetchWebText(url.replace('/list', '/large'), 'html')
  expect(page.text).toHaveLength(20000)
  expect(page.text.startsWith('Visible Visible')).toBe(true)
}, 10000)
