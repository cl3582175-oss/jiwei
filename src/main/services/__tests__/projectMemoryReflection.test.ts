import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actions, conversations, mistakes, notes, reviews, reviewLogs } from '../../db/schema'

const fixture = vi.hoisted(() => ({ directory: '', sql: null as Database.Database | null, db: null as BetterSQLite3Database | null }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.directory, getAppPath: () => process.cwd(), isPackaged: false } }))
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {} } }))
vi.mock('../../db', () => ({ getDb: () => fixture.db }))
vi.mock('../../events', () => ({ emit: () => {} }))
vi.mock('../device', () => ({ deviceId: () => 'controlled' }))
vi.mock('../settings', () => ({ getSettings: () => ({ language: 'zh-CN' }) }))
vi.mock('../notes', () => ({ getNote: () => null, listNotes: () => [], createNote: () => {}, trashNote: () => {} }))
vi.mock('../docs', () => ({ loadDoc: () => {}, replaceDoc: () => {}, stateToContent: () => [] }))
vi.mock('../feynman', () => ({ parseMeta: () => null }))
vi.mock('../ai/structured', () => ({
  structured: () => {
    throw new Error('Unexpected model call')
  }
}))
vi.mock('../progress', () => ({ listGoals: () => [], goalProgress: () => ({}) }))
vi.mock('../annotations', () => ({ recentAnnotations: () => [] }))

import { closeProfileDb } from '../../db/profile'
import { saveMemory } from '../memory'
import { reflectionMaterial } from '../reflection'

beforeEach(() => {
  fixture.directory = mkdtempSync(join(tmpdir(), 'jiwei-project-reflection-'))
  fixture.sql = new Database(':memory:')
  for (const table of [actions, conversations, mistakes, notes, reviews, reviewLogs]) {
    fixture.sql.exec(
      `CREATE TABLE "${getTableName(table)}" (${Object.values(getTableColumns(table))
        .map((column) => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}`)
        .join(', ')})`
    )
  }
  fixture.db = drizzle(fixture.sql)
})
afterEach(() => {
  closeProfileDb()
  fixture.sql?.close()
  rmSync(fixture.directory, { recursive: true, force: true })
})

it('excludes project episodes from the actual global reflection material and rendered prompt', () => {
  const now = Date.now()
  fixture
    .db!.insert(reviews)
    .values({ id: 'review', kind: 'weekly', periodStart: now - 60_000, periodEnd: now + 60_000, createdAt: now, updatedAt: now })
    .run()
  saveMemory({ kind: 'episode', content: 'GLOBAL-REFLECTION-EPISODE' }, 'ai')
  saveMemory({ kind: 'episode', content: 'PROJECT-REFLECTION-SECRET', projectId: '11111111-1111-4111-8111-111111111111' }, 'ai')
  const material = reflectionMaterial('review')
  expect(material.episodes.map((episode) => episode.content)).toEqual(['GLOBAL-REFLECTION-EPISODE'])
  expect(material.text).toContain('GLOBAL-REFLECTION-EPISODE')
  expect(JSON.stringify(material)).not.toContain('PROJECT-REFLECTION-SECRET')
})
