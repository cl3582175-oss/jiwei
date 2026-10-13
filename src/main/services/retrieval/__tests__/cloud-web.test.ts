import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getLoadablePath } from 'sqlite-vec'
import type { DB } from '../../../db'
import type { SearchHit } from '@shared/types'
import * as schema from '../../../db/knowledgeSchema'

const state = vi.hoisted(() => ({
  db: null as DB | null,
  sqlite: null as Database.Database | null,
  blocked: [] as string[],
  pageGuard: vi.fn()
}))
vi.mock('../../../db', () => ({ getDb: () => state.db }))
vi.mock('electron', () => ({ app: { isPackaged: true } }))
vi.mock('../../settings', () => ({ getSettings: () => ({ browser: { aiBlockedSites: state.blocked } }) }))
vi.mock('../reader', () => ({ assertPageReadable: state.pageGuard }))
import { filterCloudHits } from '../../ai/recordingPrivacy'

const hit = (values: Partial<SearchHit> = {}): SearchHit => ({
  parentType: 'web',
  parentId: '',
  ownerId: 'snip:fixture',
  title: 'Public article',
  text: 'Public evidence',
  url: 'https://public.example.org/article',
  locator: null,
  score: 1,
  learnedAt: null,
  updatedAt: null,
  status: null,
  origin: null,
  via: 'web',
  ...values
})
beforeEach(() => {
  state.sqlite = new Database(':memory:')
  state.sqlite.loadExtension(getLoadablePath())
  state.db = drizzle(state.sqlite, { schema })
  migrate(state.db, { migrationsFolder: 'resources/migrations' })
  state.blocked = []
  state.pageGuard.mockReset()
})
afterEach(() => state.sqlite?.close())

describe('cloud delivery of web evidence', () => {
  it('retains public web hits without treating them as notes', () => {
    const item = hit()
    expect(filterCloudHits([item])).toEqual([item])
  })
  it('rechecks current blocked sites including equivalent trailing-dot hosts', () => {
    const items = [hit(), hit({ url: 'https://public.example.org./article' })]
    expect(filterCloudHits(items)).toHaveLength(2)
    state.blocked = ['public.example.org']
    expect(filterCloudHits(items)).toEqual([])
    state.blocked = []
    expect(filterCloudHits(items)).toHaveLength(2)
  })
  it('rejects sensitive, private and missing URLs', () => {
    expect(
      filterCloudHits([hit({ url: 'https://paypal.com/article' }), hit({ url: 'http://127.0.0.1/article' }), hit({ url: undefined })])
    ).toEqual([])
  })
  it('rechecks a PDF link independently of the public landing page', () => {
    const item = hit({ meta: { pdfUrl: 'https://papers.example.org/doc.pdf' } })
    expect(filterCloudHits([item])).toEqual([item])
    state.blocked = ['papers.example.org']
    expect(filterCloudHits([item])).toEqual([])
  })
  it('rechecks exclusion of saved sources even for search snippets', () => {
    state
      .db!.insert(schema.sources)
      .values({
        id: 'source',
        kind: 'web',
        title: 'Saved',
        url: 'https://public.example.org/article',
        aiExcluded: false,
        accessedAt: 1,
        createdAt: 1,
        updatedAt: 1
      })
      .run()
    expect(filterCloudHits([hit()])).toHaveLength(1)
    state.db!.update(schema.sources).set({ aiExcluded: true }).run()
    expect(filterCloudHits([hit()])).toEqual([])
  })
  it.each(['snapshot', 'tmp-snapshot'])('checks the current policy of snapshot %s and its final URL', (parentId) => {
    const item = hit({ parentId, ownerId: parentId + ':0' })
    expect(filterCloudHits([item])).toEqual([item])
    expect(state.pageGuard).toHaveBeenCalledWith(parentId)
    state.pageGuard.mockImplementation(() => {
      throw new Error('Final URL is now excluded')
    })
    expect(filterCloudHits([item])).toEqual([])
  })
  it('preserves existing knowledge privacy checks', () => {
    state
      .db!.insert(schema.notes)
      .values({ id: 'note', title: 'Note', aiExcluded: false, learnedAt: 1, editedAt: 1, createdAt: 1, updatedAt: 1 })
      .run()
    const item = hit({ parentType: 'note', parentId: 'note' })
    expect(filterCloudHits([item])).toEqual([item])
    state.db!.update(schema.notes).set({ aiExcluded: true }).run()
    expect(filterCloudHits([item])).toEqual([])
  })
})
