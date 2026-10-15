import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq, getTableColumns, getTableName } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actions, annotations, blocks, cards, conversations, mistakes, notes, reviews, reviewLogs, sources } from '../../db/schema'

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
vi.mock('../ai/indexer', () => ({ requestIndex: () => {} }))
vi.mock('../assets', () => ({ assetPath: () => '' }))
vi.mock('../progress', () => ({ listGoals: () => [], goalProgress: () => ({}) }))

import { closeProfileDb } from '../../db/profile'
import { recentAnnotations } from '../annotations'
import { reflectionMaterial } from '../reflection'

let now: number
beforeEach(() => {
  fixture.directory = mkdtempSync(join(tmpdir(), 'jiwei-project-source-reflection-'))
  fixture.sql = new Database(':memory:')
  for (const table of [actions, annotations, blocks, cards, conversations, mistakes, notes, reviews, reviewLogs, sources]) {
    fixture.sql.exec(
      `CREATE TABLE "${getTableName(table)}" (${Object.values(getTableColumns(table))
        .map((column) => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}`)
        .join(', ')})`
    )
  }
  fixture.db = drizzle(fixture.sql)
  now = Date.now()
  fixture.db
    .insert(reviews)
    .values({ id: 'review', kind: 'weekly', periodStart: now - 60_000, periodEnd: now + 60_000, createdAt: now, updatedAt: now })
    .run()
})
afterEach(() => {
  closeProfileDb()
  fixture.sql?.close()
  rmSync(fixture.directory, { recursive: true, force: true })
})

function note(id: string, title: string, aiExcluded: boolean): void {
  fixture
    .db!.insert(notes)
    .values({ id, title, aiExcluded, userAiExcluded: false, learnedAt: now, editedAt: now, createdAt: now, updatedAt: now })
    .run()
}

function cue(noteId: string, text: string): void {
  fixture
    .db!.insert(blocks)
    .values({
      id: `cue:${noteId}`,
      noteId,
      kind: 'paragraph',
      section: 'cue',
      rowId: `row:${noteId}`,
      position: 0,
      text,
      hash: 'controlled',
      createdAt: now,
      updatedAt: now
    })
    .run()
  fixture
    .db!.insert(cards)
    .values({ id: `card:${noteId}`, noteId, blockId: `row:${noteId}`, due: now, createdAt: now, updatedAt: now })
    .run()
  fixture
    .db!.insert(reviewLogs)
    .values({
      id: `log:${noteId}`,
      cardId: `card:${noteId}`,
      rating: 1,
      state: 2,
      due: now,
      stability: 1,
      difficulty: 1,
      elapsedDays: 1,
      scheduledDays: 1,
      reviewedAt: now
    })
    .run()
}

function annotation(targetType: 'note' | 'source', targetId: string, marker: string): void {
  fixture
    .db!.insert(annotations)
    .values({
      id: `annotation:${targetId}`,
      targetType,
      targetId,
      selector: JSON.stringify({ quote: `${marker}-QUOTE` }),
      motivation: 'commenting',
      body: `${marker}-BODY`,
      createdAt: now,
      updatedAt: now
    })
    .run()
}

it('keeps private derived note titles and cues out of global reflection material', () => {
  note('public', 'PUBLIC-TITLE', false)
  note('derived', 'PROJECT-PRIVATE-TITLE', true)
  cue('public', 'PUBLIC-CUE')
  cue('derived', 'PROJECT-PRIVATE-CUE')

  const material = reflectionMaterial('review')
  expect(material.notes.map((entry) => entry.title)).toEqual(['PUBLIC-TITLE'])
  expect(material.unanswered.map((entry) => entry.question)).toEqual(['PUBLIC-CUE'])
  expect(material.review.hardest.map((entry) => entry.question)).toEqual(['PUBLIC-CUE'])
  expect(material.text).toContain('PUBLIC-TITLE')
  expect(material.text).toContain('PUBLIC-CUE')
  expect(JSON.stringify(material)).not.toContain('PROJECT-PRIVATE')
})

it('excludes private source and derived-note annotations while retaining their normal UI listing', () => {
  note('derived', 'PROJECT-PRIVATE-TITLE', true)
  annotation('note', 'derived', 'PROJECT-PRIVATE-NOTE')
  for (const [id, space, aiExcluded] of [
    ['upload', 'attachment', true],
    ['text', 'attachment', true],
    ['url', 'attachment', true],
    ['attachment-flag-off', 'attachment', false],
    ['excluded-library', 'library', true],
    ['archived', 'library', false]
  ] as const) {
    fixture
      .db!.insert(sources)
      .values({ id, title: `${id}-TITLE`, kind: 'document', space, aiExcluded, accessedAt: now, createdAt: now, updatedAt: now })
      .run()
    annotation('source', id, id === 'archived' ? 'PUBLIC-ARCHIVED' : 'PROJECT-PRIVATE')
  }

  const material = reflectionMaterial('review')
  expect(material.annotations.highlights).toBe(1)
  expect(material.annotations.items.map((entry) => entry.targetId)).toEqual(['archived'])
  expect(material.text).toContain('PUBLIC-ARCHIVED-QUOTE')
  expect(material.text).toContain('PUBLIC-ARCHIVED-BODY')
  expect(JSON.stringify(material)).not.toContain('PROJECT-PRIVATE')
  expect(recentAnnotations(now - 60_000, now + 60_000)).toHaveLength(7)
})

it('rechecks source archive and note exclusion before assembling each reflection material', () => {
  note('derived', 'PROJECT-PRIVATE-TITLE', true)
  fixture
    .db!.insert(sources)
    .values({
      id: 'upload',
      title: 'PROJECT-PRIVATE-SOURCE',
      kind: 'document',
      space: 'attachment',
      aiExcluded: true,
      accessedAt: now,
      createdAt: now,
      updatedAt: now
    })
    .run()
  annotation('source', 'upload', 'PROJECT-PRIVATE-SOURCE')
  expect(JSON.stringify(reflectionMaterial('review'))).not.toContain('PROJECT-PRIVATE')

  fixture.db!.update(sources).set({ space: 'library', aiExcluded: false }).where(eq(sources.id, 'upload')).run()
  fixture.db!.update(notes).set({ aiExcluded: false }).where(eq(notes.id, 'derived')).run()
  const released = reflectionMaterial('review')
  expect(released.notes.map((entry) => entry.id)).toEqual(['derived'])
  expect(released.annotations.items.map((entry) => entry.targetId)).toEqual(['upload'])

  fixture.db!.update(sources).set({ aiExcluded: true }).where(eq(sources.id, 'upload')).run()
  expect(reflectionMaterial('review').annotations.items).toEqual([])
})
