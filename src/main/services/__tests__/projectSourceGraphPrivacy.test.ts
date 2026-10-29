import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq, getTableColumns, getTableName } from 'drizzle-orm'
import { blocks, links, notes } from '../../db/schema'

const fixture = vi.hoisted(() => ({
  sql: null as Database.Database | null,
  db: null as BetterSQLite3Database | null,
  transmissions: [] as { mode: string; prompt: string }[],
  discovery: null as (() => void) | null,
  generation: null as ((mode: string, prompt: string) => void) | null
}))
vi.mock('../../db', () => ({ getDb: () => fixture.db, getSqlite: () => fixture.sql }))
vi.mock('electron', () => ({ app: { getLocale: () => 'zh-CN', isPackaged: false } }))
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {} } }))
vi.mock('../../events', () => ({ emit: () => {} }))
vi.mock('../device', () => ({ deviceId: () => 'controlled' }))
vi.mock('../settings', () => ({
  getSettings: () => ({ language: 'zh-CN', ai: { chat: { providerId: 'controlled', model: 'test-model' } } })
}))
vi.mock('../agent/context', () => ({
  withRun: (_: unknown, fn: () => unknown) => fn(),
  withPurpose: (_: string, fn: () => unknown) => fn()
}))
vi.mock('../agent/usage', () => ({ checkBudget: () => {}, perRunLimit: () => null }))
vi.mock('../connections', () => ({
  relatedByVectors: async () => {
    fixture.discovery?.()
    return []
  }
}))
vi.mock('../ai/providers', () => ({ getProviderRow: () => ({ modelCaps: '{}', models: '["test-model"]' }) }))
// Keep the graph service and structured first-call/JSON-retry flow real; replace only outbound requests.
vi.mock('../ai/request', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/request')>()),
  createModelRequest: (request: { prompt: string }) => ({
    generate: async (mode: string) => {
      fixture.transmissions.push({ mode, prompt: request.prompt })
      fixture.generation?.(mode, request.prompt)
      const rows = JSON.parse(request.prompt.slice(request.prompt.indexOf('\n') + 1, request.prompt.lastIndexOf('\n'))) as { i: number }[]
      const output = {
        items: rows.map(({ i }) => ({
          i,
          relation: 'prerequisite',
          subject: 'a',
          reason: 'Public relationship',
          quote: '',
          confidence: 0.9
        }))
      }
      return { toolCalls: [{ toolName: 'submit', input: output }], text: JSON.stringify(output) }
    },
    diagnostics: () => ({}),
    state: {}
  }),
  logModelFailure: () => {},
  ModelOutputTruncated: class extends Error {}
}))

import { suggestRelations } from '../graphAi'

beforeEach(() => {
  fixture.sql = new Database(':memory:')
  for (const table of [blocks, links, notes]) {
    fixture.sql.exec(
      `CREATE TABLE "${getTableName(table)}" (${Object.values(getTableColumns(table))
        .map((column) => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}`)
        .join(', ')})`
    )
  }
  fixture.db = drizzle(fixture.sql)
  fixture.transmissions = []
  fixture.discovery = null
  fixture.generation = null
})
afterEach(() => fixture.sql?.close())

function pair(index: number): void {
  for (const side of ['a', 'b'])
    fixture
      .db!.insert(notes)
      .values({
        id: `${index}-${side}`,
        title: `PAIR-${index}-${side}`,
        plainText: `BODY-${index}-${side}`,
        learnedAt: 1,
        createdAt: 1,
        updatedAt: 1,
        editedAt: 1
      })
      .run()
  fixture
    .db!.insert(links)
    .values({
      id: `link-${index}`,
      fromType: 'note',
      fromId: `${index}-a`,
      toType: 'note',
      toId: `${index}-b`,
      relation: 'reference',
      origin: 'doc',
      createdAt: 1,
      updatedAt: 1
    })
    .run()
}

it.each(['excluded', 'deleted'])(
  'filters a cached pair that becomes %s during asynchronous discovery and keeps public pairs',
  async (change) => {
    pair(0)
    pair(1)
    fixture.discovery = () =>
      fixture
        .db!.update(notes)
        .set(change === 'excluded' ? { aiExcluded: true } : { deletedAt: 2 })
        .where(eq(notes.id, '0-a'))
        .run()

    expect(await suggestRelations()).toEqual({ judged: 1, suggested: 1 })
    expect(fixture.transmissions).toHaveLength(1)
    expect(fixture.transmissions[0].prompt).not.toContain('PAIR-0-a')
    expect(fixture.transmissions[0].prompt).toContain('PAIR-1-a')
  }
)

it('rechecks each later batch after an earlier request made one of its note pairs private', async () => {
  for (let index = 0; index < 12; index++) pair(index)
  let privateTitle = ''
  fixture.generation = (_mode, prompt) => {
    if (fixture.transmissions.length !== 1) return
    const index = Array.from({ length: 12 }, (_, i) => i).find((i) => !prompt.includes(`PAIR-${i}-a`))!
    privateTitle = `PAIR-${index}-a`
    fixture
      .db!.update(notes)
      .set({ aiExcluded: true })
      .where(eq(notes.id, `${index}-a`))
      .run()
  }

  expect(await suggestRelations()).toEqual({ judged: 11, suggested: 11 })
  expect(fixture.transmissions).toHaveLength(2)
  expect(fixture.transmissions.map((entry) => entry.prompt).join()).not.toContain(privateTitle)
  expect(fixture.sql!.prepare("SELECT count(*) AS n FROM links WHERE origin='ai'").get()).toEqual({ n: 11 })
})

it('prevents the structured JSON retry from resending a pair whose note became private after the first attempt', async () => {
  pair(0)
  fixture.generation = (mode) => {
    if (mode !== 'tool') return
    fixture.db!.update(notes).set({ aiExcluded: true }).where(eq(notes.id, '0-a')).run()
    throw new Error('Controlled first-attempt failure')
  }

  await expect(suggestRelations()).rejects.toThrow(/permission changed/i)
  expect(fixture.transmissions.map((entry) => entry.mode)).toEqual(['tool'])
  expect(fixture.sql!.prepare("SELECT count(*) AS n FROM links WHERE origin='ai'").get()).toEqual({ n: 0 })
})
