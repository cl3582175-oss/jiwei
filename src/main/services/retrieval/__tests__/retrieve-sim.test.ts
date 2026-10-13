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
  ready: vi.fn(),
  embed: vi.fn(),
  rows: [] as { rowid: number; distance: number }[]
}))
vi.mock('../../../db', () => ({
  getDb: () => state.db,
  getSqlite: () => ({
    prepare: (sql: string) => (sql.includes('vec_chunks WHERE embedding MATCH') ? { all: () => state.rows } : state.sqlite!.prepare(sql))
  })
}))
vi.mock('../../ai/embedding', () => ({ isReady: state.ready, embed: state.embed }))
vi.mock('../../ai/indexer', () => ({ annotationText: () => '', vecBuffer: (v: number[]) => Buffer.from(new Float32Array(v).buffer) }))
import { retrieve } from '../../ai/retrieve'

beforeEach(() => {
  state.sqlite = new Database(':memory:')
  state.sqlite.loadExtension(getLoadablePath())
  state.db = drizzle(state.sqlite, { schema })
  migrate(state.db, { migrationsFolder: 'resources/migrations' })
  state.ready.mockReset().mockResolvedValue(true)
  state.embed
    .mockReset()
    .mockImplementation(async (_texts: string[], kind: string) => (kind === 'query' ? [[1, 0]] : _texts.map(() => [0.6, 0.8])))
  state.rows = []
})
afterEach(() => {
  state.sqlite?.close()
  state.sqlite = null
  state.db = null
})

function note(id: string, text: string, options: { excluded?: boolean; status?: 'active' | 'outdated'; indexed?: boolean } = {}): void {
  state
    .db!.insert(schema.notes)
    .values({
      id,
      title: `Title ${id}`,
      aiExcluded: options.excluded ?? false,
      status: options.status ?? 'active',
      learnedAt: 1,
      editedAt: 1,
      createdAt: 1,
      updatedAt: 1
    })
    .run()
  state
    .db!.insert(schema.blocks)
    .values({ id: `block-${id}`, noteId: id, kind: 'row', section: 'row', position: 0, text, hash: id, createdAt: 1, updatedAt: 1 })
    .run()
  state.sqlite!.prepare('INSERT INTO blocks_fts(block_id,text) VALUES (?,?)').run(`block-${id}`, text)
  if (options.indexed)
    state
      .db!.insert(schema.chunks)
      .values({
        rowid: 1,
        ownerType: 'block',
        ownerId: `block-${id}`,
        parentType: 'note',
        parentId: id,
        hash: id,
        model: 'fixture',
        createdAt: 1
      })
      .run()
}

describe('retrieval similarity metadata', () => {
  it('uses the minimum vector distance for an owner, clamps similarity and does not recompute vector hits', async () => {
    note('vector', 'Semantic evidence', { indexed: true })
    state.rows = [
      { rowid: 1, distance: 0.4 },
      { rowid: 1, distance: 0.2 }
    ]
    const hits = await retrieve('topic', { type: 'all' })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ via: 'semantic', sim: 0.8 })
    expect(state.embed).toHaveBeenCalledTimes(1)
    state.rows = [{ rowid: 1, distance: -0.1 }]
    expect((await retrieve('topic', { type: 'all' }))[0].sim).toBe(1)
    state.rows = [{ rowid: 1, distance: 1.5 }]
    expect((await retrieve('topic', { type: 'all' }))[0].sim).toBe(0)
  })
  it('supplements only eligible final keyword hits in one document batch with their titles', async () => {
    note('a', 'topic keyword evidence')
    note('b', 'topic other evidence')
    note('excluded', 'topic confidential', { excluded: true })
    const hits = await retrieve('topic', { type: 'all' }, 1)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ via: 'keyword', sim: 0.6 })
    expect(state.embed.mock.calls).toEqual([
      [['topic'], 'query'],
      [[hits[0].text], 'doc', [hits[0].title]]
    ])
  })
  it('batches all final keyword hits even when no indexed vectors exist', async () => {
    note('a', 'topic keyword evidence')
    note('b', 'topic other evidence')
    const hits = await retrieve('topic', { type: 'all' }, 2)
    expect(hits.every((h) => h.sim === 0.6)).toBe(true)
    expect(state.embed).toHaveBeenCalledTimes(2)
    expect(state.embed.mock.calls[1][0]).toHaveLength(2)
  })
  it.each(['not-ready', 'query-error', 'document-error'])(
    'preserves RRF/weight/prefer order with %s and leaves unavailable similarity absent',
    async (failure) => {
      note('a', 'topic evidence', { status: 'outdated' })
      note('b', 'topic evidence')
      state.ready.mockResolvedValue(false)
      const baseline = await retrieve('topic', { type: 'all' }, 2, {}, 'a')
      state.ready.mockResolvedValue(failure !== 'not-ready')
      state.embed.mockImplementation(async (_texts: string[], kind: string) => {
        if ((failure === 'query-error' && kind === 'query') || (failure === 'document-error' && kind === 'doc'))
          throw new Error('controlled unavailable embedding')
        return [[1, 0]]
      })
      const hits = await retrieve('topic', { type: 'all' }, 2, {}, 'a')
      expect(hits.map((h) => ({ ownerId: h.ownerId, score: h.score, via: h.via }))).toEqual(
        baseline.map((h) => ({ ownerId: h.ownerId, score: h.score, via: h.via }))
      )
      expect(hits.every((h) => h.sim === undefined)).toBe(true)
    }
  )
})
