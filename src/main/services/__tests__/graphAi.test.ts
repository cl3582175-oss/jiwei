import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getLoadablePath } from 'sqlite-vec'

const fixture = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sqlite: null as Database.Database | null,
  prompts: [] as string[],
  answer: (_prompt: string): unknown => ({ items: [] })
}))
vi.mock('../../db', () => ({ getDb: () => fixture.db, getSqlite: () => fixture.sqlite }))
vi.mock('electron', () => ({ app: { getLocale: () => 'zh-CN', isPackaged: false }, nativeTheme: { themeSource: 'system' } }))
vi.mock('../../events', () => ({ emit: () => undefined }))
vi.mock('../device', () => ({ deviceId: () => 'test-device' }))
vi.mock('../settings', () => ({ getSettings: () => ({ language: 'zh-CN', ai: { chat: { providerId: 'p', model: 'm' } } }) }))
vi.mock('../agent/context', () => ({ withRun: (_run: unknown, fn: () => unknown) => fn() }))
vi.mock('../agent/usage', () => ({ checkBudget: () => undefined, perRunLimit: () => null }))
vi.mock('../connections', () => ({ relatedByVectors: async () => [] }))
vi.mock('../ai/structured', () => ({
  quickModel: (_p: string, m: string) => m,
  structured: async (opts: { prompt: string }) => {
    fixture.prompts.push(opts.prompt)
    return fixture.answer(opts.prompt)
  }
}))
import { acceptSuggestion, rejectSuggestion, suggestRelations } from '../graphAi'

const links = (): {
  from_id: string
  to_id: string
  relation: string
  origin: string
  status: string
  reason: string | null
  deleted_at: number | null
}[] =>
  fixture
    .sqlite!.prepare('SELECT from_id, to_id, relation, origin, status, reason, deleted_at FROM links ORDER BY created_at, rowid')
    .all() as never

beforeEach(() => {
  fixture.sqlite = new Database(':memory:')
  fixture.sqlite.loadExtension(getLoadablePath())
  const folder = join(process.cwd(), 'resources', 'migrations')
  for (const file of readdirSync(folder)
    .filter((name) => name.endsWith('.sql'))
    .sort())
    fixture.sqlite.exec(readFileSync(join(folder, file), 'utf8'))
  fixture.db = drizzle(fixture.sqlite)
  fixture.prompts = []
  const note = (id: string, title: string, text: string, ai = 0): string =>
    `INSERT INTO notes (id,title,plain_text,ai_excluded,learned_at,created_at,updated_at,edited_at) VALUES ('${id}','${title}','${text}',${ai},1,1,1,1);`
  const link = (id: string, from: string, to: string): string =>
    `INSERT INTO links (id,from_type,from_id,to_type,to_id,relation,origin,created_at,updated_at) VALUES ('${id}','note','${from}','note','${to}','reference','doc',1,1);`
  fixture.sqlite.exec(
    note('p', 'p 值', '原假设成立时的极端概率') +
      note('ab', 'A/B 测试', '做 A/B 测试前得先懂 p 值') +
      note('secret', '私密', '不给 AI', 1) +
      link('l1', 'ab', 'p') +
      link('l2', 'secret', 'p') +
      `INSERT INTO links (id,from_type,from_id,to_type,to_id,relation,origin,created_at,updated_at) VALUES ('m1','note','ab','note','p','related','manual',1,1);`
  )
})
afterEach(() => fixture.sqlite?.close())

it('只把不给 AI 以外的笔记交给模型；结果存为建议，原有关系不变', async () => {
  fixture.answer = () => ({
    items: [{ i: 0, relation: 'prerequisite', subject: 'b', reason: '先懂 p 值才能做 A/B 测试', quote: '先懂 p 值', confidence: 0.9 }]
  })
  const r = await suggestRelations()
  expect(r).toEqual({ judged: 1, suggested: 1 })
  expect(fixture.prompts.join()).not.toContain('私密')
  const ai = links().filter((l) => l.origin === 'ai')
  expect(ai).toEqual([
    expect.objectContaining({
      from_id: 'p',
      to_id: 'ab',
      relation: 'prerequisite',
      status: 'suggested',
      reason: '先懂 p 值才能做 A/B 测试'
    })
  ])
  expect(
    links()
      .filter((l) => l.origin !== 'ai')
      .every((l) => l.status === 'confirmed')
  ).toBe(true)
  // 判断过的笔记对不再发给模型
  fixture.prompts = []
  expect(await suggestRelations()).toEqual({ judged: 0, suggested: 0 })
  expect(fixture.prompts).toHaveLength(0)
})

it('无明确关系或置信度低的不成为建议，但记下以后不再判断', async () => {
  fixture.answer = () => ({ items: [{ i: 0, relation: 'contrasts', subject: 'a', reason: '?', quote: '', confidence: 0.3 }] })
  expect(await suggestRelations()).toEqual({ judged: 1, suggested: 0 })
  expect(links().filter((l) => l.origin === 'ai')).toEqual([expect.objectContaining({ status: 'rejected', relation: 'related' })])
})

it('确认后成为唯一的手动关系，否决后不再出现', async () => {
  fixture.answer = () => ({ items: [{ i: 0, relation: 'prerequisite', subject: 'b', reason: '理由', quote: '', confidence: 0.9 }] })
  await suggestRelations()
  const id = (fixture.sqlite!.prepare("SELECT id FROM links WHERE origin='ai'").get() as { id: string }).id
  rejectSuggestion(id)
  expect(links().find((l) => l.origin === 'ai')?.status).toBe('rejected')
  fixture.sqlite!.exec(`UPDATE links SET status='suggested' WHERE id='${id}'`)
  acceptSuggestion(id)
  const manual = links().filter((l) => l.origin === 'manual' && l.deleted_at === null)
  expect(manual).toEqual([expect.objectContaining({ from_id: 'p', to_id: 'ab', relation: 'prerequisite', status: 'confirmed' })])
})
