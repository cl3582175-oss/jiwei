import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getLoadablePath } from 'sqlite-vec'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { JobContext, JobKind } from '../jobs'

const f = vi.hoisted(() => ({
  sql: null as Database.Database | null,
  db: null as ReturnType<typeof drizzle> | null,
  run: null as JobKind['run'] | null,
  embedded: [] as number[]
}))
vi.mock('../../db', () => ({ getDb: () => f.db, getSqlite: () => f.sql }))
vi.mock('../../events', () => ({ emit: () => {} }))
vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }))
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {} } }))
vi.mock('../settings', () => ({ getSettings: () => ({ ai: { embedding: { mode: 'local' } } }) }))
vi.mock('../ai/embedding', () => ({
  currentModelId: () => 'controlled',
  isReady: async () => true,
  setStatus: () => {},
  embed: async (texts: string[]) => {
    f.embedded.push(texts.length)
    return texts.map(() => [1, ...Array(511).fill(0)])
  }
}))
vi.mock('../jobs', async (original) => ({
  ...(await original<typeof import('../jobs')>()),
  registerJobKind: (_name: string, definition: JobKind) => {
    f.run = definition.run
  }
}))
import { JobDeferred } from '../jobs'
import { registerIndexJob, syncIndex } from '../ai/indexer'
import { replaceSegments } from '../segments'

beforeEach(() => {
  f.sql = new Database(':memory:')
  f.sql.loadExtension(getLoadablePath())
  for (const file of readdirSync(join(process.cwd(), 'resources/migrations'))
    .filter((p) => p.endsWith('.sql'))
    .sort())
    f.sql.exec(readFileSync(join(process.cwd(), 'resources/migrations', file), 'utf8'))
  f.db = drizzle(f.sql)
  f.embedded = []
  f.sql.exec("INSERT INTO sources(id,title,kind,accessed_at,created_at,updated_at) VALUES('source','Controlled source','pdf',1,1,1)")
  replaceSegments(
    'source',
    Array.from({ length: 65 }, (_, i) => ({ kind: 'text', text: `第 ${i + 1} 条用于验证分批索引续跑的合成文字。`, locator: {} }))
  )
})
afterEach(() => f.sql?.close())

it('yields after a durable batch and resumes without removing or re-embedding that batch', async () => {
  const deferred = new JobDeferred(0, 'yield')
  await expect(
    syncIndex(
      () => {},
      () => false,
      () => {
        throw deferred
      }
    )
  ).rejects.toBe(deferred)
  expect(f.sql!.prepare('SELECT count(*) n FROM chunks').get()).toEqual({ n: 32 })
  expect(f.sql!.prepare('SELECT count(*) n FROM vec_chunks').get()).toEqual({ n: 32 })
  expect(
    await syncIndex(
      () => {},
      () => false
    )
  ).toEqual({ added: 33, removed: 0 })
  expect(f.embedded).toEqual([32, 32, 1])
  expect(f.sql!.prepare('SELECT count(*) n FROM vec_chunks').get()).toEqual({ n: 65 })
})

it('the registered index job passes its actual context yield point into the batch loop', async () => {
  registerIndexJob()
  const deferred = new JobDeferred(0, 'yield')
  const ctx: JobContext = {
    progress: () => {},
    isCanceled: () => false,
    yieldPoint: () => {
      throw deferred
    },
    step: (_key, _source, run) => run(),
    worker: async () => {
      throw new Error('The index job does not use a worker')
    }
  }
  await expect(f.run!({}, ctx)).rejects.toBe(deferred)
  expect(f.sql!.prepare('SELECT count(*) n FROM chunks').get()).toEqual({ n: 32 })
})
