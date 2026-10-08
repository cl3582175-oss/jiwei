import { randomUUID } from 'crypto'
import { and, asc, desc, eq, isNull, like, or, inArray, type SQL } from 'drizzle-orm'
import { getDb, getSqlite } from '../db'
import { notes } from '../db/schema'
import { recordActivity } from './stats'
import type { DocJSON, Note, NoteQuery, NoteSummary, NoteUpdate } from '@shared/types'

const EMPTY_DOC: DocJSON = { type: 'doc', content: [{ type: 'paragraph' }] }
const EXCERPT_LEN = 120

type Row = typeof notes.$inferSelect

function toSummary(r: Row): NoteSummary {
  return {
    id: r.id,
    title: r.title,
    categoryId: r.categoryId,
    pinned: r.pinned,
    excerpt: r.plainText.slice(0, EXCERPT_LEN),
    wordCount: r.wordCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt
  }
}

function parseDoc(s: string): DocJSON {
  try {
    return JSON.parse(s) as DocJSON
  } catch {
    return EMPTY_DOC
  }
}

/** 中英文混合字数：每个 CJK 字符计 1，每个拉丁单词计 1 */
export function countWords(text: string): number {
  const cjk = text.match(/[㐀-鿿豈-﫿]/g)?.length ?? 0
  const latin = text.replace(/[㐀-鿿豈-﫿]/g, ' ').match(/[A-Za-z0-9]+/g)?.length ?? 0
  return cjk + latin
}

/** 用 FTS5 trigram 检索；查询少于 3 个字符时回退到 LIKE */
function searchIds(search: string): string[] | null {
  const q = search.trim()
  if (!q) return null
  if ([...q].length < 3) return null
  const phrase = '"' + q.replace(/"/g, '""') + '"'
  const rows = getSqlite()
    .prepare('SELECT note_id FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT 500')
    .all(phrase) as { note_id: string }[]
  return rows.map((r) => r.note_id)
}

export function listNotes(query: NoteQuery): NoteSummary[] {
  const conds: SQL[] = [isNull(notes.deletedAt)]
  if (query.categoryId !== undefined) {
    conds.push(query.categoryId === null ? isNull(notes.categoryId) : eq(notes.categoryId, query.categoryId))
  }
  if (query.pinnedOnly) conds.push(eq(notes.pinned, true))
  if (query.search?.trim()) {
    const ids = searchIds(query.search)
    if (ids) {
      if (ids.length === 0) return []
      conds.push(inArray(notes.id, ids))
    } else {
      const pat = `%${query.search.trim()}%`
      conds.push(or(like(notes.title, pat), like(notes.plainText, pat))!)
    }
  }
  const order =
    query.sort === 'title' ? asc(notes.title) : query.sort === 'created' ? desc(notes.createdAt) : desc(notes.updatedAt)
  return getDb()
    .select()
    .from(notes)
    .where(and(...conds))
    .orderBy(desc(notes.pinned), order)
    .all()
    .map(toSummary)
}

export function getNote(id: string): Note | null {
  const r = getDb().select().from(notes).where(eq(notes.id, id)).get()
  if (!r) return null
  return { ...toSummary(r), cue: parseDoc(r.cue), content: parseDoc(r.content), summary: parseDoc(r.summary) }
}

export function createNote(init?: { categoryId?: string | null; title?: string }): Note {
  const now = Date.now()
  const empty = JSON.stringify(EMPTY_DOC)
  const id = randomUUID()
  getDb()
    .insert(notes)
    .values({
      id,
      title: init?.title ?? '',
      categoryId: init?.categoryId ?? null,
      cue: empty,
      content: empty,
      summary: empty,
      createdAt: now,
      updatedAt: now
    })
    .run()
  recordActivity('note_create')
  return getNote(id)!
}

export function updateNote(id: string, patch: NoteUpdate): NoteSummary {
  const db = getDb()
  const prev = db.select().from(notes).where(eq(notes.id, id)).get()
  if (!prev) throw new Error(`Note not found: ${id}`)
  const set: Partial<Row> = {}
  if (patch.title !== undefined) set.title = patch.title
  if (patch.categoryId !== undefined) set.categoryId = patch.categoryId
  if (patch.pinned !== undefined) set.pinned = patch.pinned
  if (patch.cue) set.cue = JSON.stringify(patch.cue)
  if (patch.content) set.content = JSON.stringify(patch.content)
  if (patch.summary) set.summary = JSON.stringify(patch.summary)
  if (patch.plainText !== undefined) {
    set.plainText = patch.plainText
    set.wordCount = countWords(patch.plainText)
  }
  // 仅置顶/分类变化不视为内容编辑，不刷新更新时间
  const isEdit = patch.title !== undefined || patch.cue || patch.content || patch.summary
  if (isEdit) set.updatedAt = Date.now()
  db.update(notes).set(set).where(eq(notes.id, id)).run()
  if (isEdit) {
    recordActivity('note_edit')
    const delta = (set.wordCount ?? prev.wordCount) - prev.wordCount
    if (delta > 0) recordActivity('words', delta)
  }
  return toSummary(db.select().from(notes).where(eq(notes.id, id)).get()!)
}

export function trashNote(id: string): void {
  getDb().update(notes).set({ deletedAt: Date.now() }).where(eq(notes.id, id)).run()
}
