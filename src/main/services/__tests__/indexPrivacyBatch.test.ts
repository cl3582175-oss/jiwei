import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getLoadablePath } from 'sqlite-vec'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const f = vi.hoisted(() => ({
  sql: null as Database.Database | null,
  db: null as ReturnType<typeof drizzle> | null,
  inputs: [] as string[][]
}))
vi.mock('../../db', () => ({ getDb: () => f.db, getSqlite: () => f.sql }))
vi.mock('electron', () => ({
  net: {
    fetch: async (_url: string, init: { body: string }) => {
      const inputs = (JSON.parse(init.body) as { input: string[] }).input
      f.inputs.push(inputs)
      f.sql!.exec("UPDATE sources SET ai_excluded=1 WHERE id='s'")
      return Response.json({ data: inputs.map((_, index) => ({ index, embedding: [1, ...Array(511).fill(0)] })) })
    }
  }
}))
vi.mock('electron-log/main', () => ({ default: { info: () => {}, error: () => {} } }))
vi.mock('../../events', () => ({ emit: () => {} }))
vi.mock('../settings', () => ({
  getSettings: () => ({ ai: { embedding: { mode: 'cloud', providerId: 'controlled', model: 'controlled' } } })
}))
vi.mock('../ai/providers', () => ({ getProviderRow: () => ({ baseUrl: 'https://controlled.invalid' }), decryptKey: () => '' }))
vi.mock('../ai/localEmbedding', () => ({}))
vi.mock('../jobs', () => ({ enqueue: () => {}, registerJobKind: () => {} }))
import { syncIndex } from '../ai/indexer'
import { replaceSegments } from '../segments'

beforeEach(() => {
  f.sql = new Database(':memory:')
  f.sql.loadExtension(getLoadablePath())
  f.db = drizzle(f.sql)
  f.inputs = []
  const dir = join(process.cwd(), 'resources/migrations')
  for (const file of readdirSync(dir)
    .filter((p) => p.endsWith('.sql'))
    .sort())
    f.sql.exec(readFileSync(join(dir, file), 'utf8'))
})
afterEach(() => f.sql?.close())

it('rechecks privacy between real internal cloud batches and before persisting vectors', async () => {
  f.sql!.exec("INSERT INTO sources(id,title,kind,accessed_at,created_at,updated_at) VALUES('s','合成资料','pdf',1,1,1)")
  replaceSegments(
    's',
    Array.from({ length: 32 }, (_, i) => ({ kind: 'paragraph', text: `第${i}条合成内容用于分批权限回归。`, locator: {} }))
  )
  await expect(
    syncIndex(
      () => {},
      () => false
    )
  ).rejects.toThrow(/permission|权限/)
  expect(f.inputs).toHaveLength(1)
  expect(f.inputs[0]).toHaveLength(16)
  expect(f.sql!.prepare('SELECT count(*) n FROM chunks').get()).toEqual({ n: 0 })
  expect(f.sql!.prepare('SELECT count(*) n FROM vec_chunks').get()).toEqual({ n: 0 })
})
