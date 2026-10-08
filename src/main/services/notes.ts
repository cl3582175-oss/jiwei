import { and, asc, desc, eq, inArray, isNull, like, or, type SQL } from 'drizzle-orm'
import { getDb, getSqlite } from '../db'
import { notes, taggings } from '../db/schema'
import { newId } from '../lib/ids'
import { deviceId } from './device'
import { recordActivity } from './stats'
import { initDoc } from './docs'
import { deletedCategoryIds, descendantIds } from './categories'
import { entitiesWithTag, tagIdsFor } from './tags'
import { DOC_VERSION, type Note, type NoteMetaUpdate, type NoteQuery, type NoteSummary } from '@shared/types'

const EXCERPT_LEN = 140

// 列表查询只取需要的列，绝不读取正文
const summaryCols = {
  id: notes.id,
  title: notes.title,
  categoryId: notes.categoryId,
  pinned: notes.pinned,
  learnedAt: notes.learnedAt,
  status: notes.status,
  supersededBy: notes.supersededBy,
  aiExcluded: notes.aiExcluded,
  plainText: notes.plainText,
  wordCount: notes.wordCount,
  createdAt: notes.createdAt,
  editedAt: notes.editedAt,
  updatedAt: notes.updatedAt,
  deletedAt: notes.deletedAt
}

type Row = { [K in keyof typeof summaryCols]: (typeof notes.$inferSelect)[K] }

function toSummaries(rows: Row[]): NoteSummary[] {
  const tagMap = tagIdsFor('note', rows.map((r) => r.id))
  return rows.map(({ plainText, ...r }) => ({
    ...r,
    excerpt: plainText.slice(0, EXCERPT_LEN),
    tagIds: tagMap.get(r.id) ?? []
  }))
}

/** FTS5 trigram 检索；查询少于 3 个字符时返回 null（回退到 LIKE） */
function searchIds(search: string): string[] | null {
  const q = search.trim()
  if ([...q].length < 3) return null
  const phrase = '"' + q.replace(/"/g, '""') + '"'
  const rows = getSqlite()
    .prepare('SELECT note_id FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT 1000')
    .all(phrase) as { note_id: string }[]
  return rows.map((r) => r.note_id)
}

export function listNotes(query: NoteQuery): NoteSummary[] {
  const conds: SQL[] = [isNull(notes.deletedAt)]
  if (query.categoryId !== undefined) {
    if (query.categoryId === null) {
      const dead = deletedCategoryIds()
      conds.push(dead.length ? or(isNull(notes.categoryId), inArray(notes.categoryId, dead))! : isNull(notes.categoryId))
    } else {
      conds.push(inArray(notes.categoryId, query.includeDescendants ? descendantIds(query.categoryId) : [query.categoryId]))
    }
  }
  if (query.tagId) conds.push(inArray(notes.id, entitiesWithTag('note', query.tagId)))
  if (query.pinnedOnly) conds.push(eq(notes.pinned, true))
  if (query.status) conds.push(eq(notes.status, query.status))
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
  const order = {
    title: asc(notes.title),
    created: desc(notes.createdAt),
    learned: desc(notes.learnedAt),
    edited: desc(notes.editedAt)
  }[query.sort ?? 'edited']
  let q = getDb()
    .select(summaryCols)
    .from(notes)
    .where(and(...conds))
    .orderBy(desc(notes.pinned), order)
    .$dynamic()
  if (query.limit) q = q.limit(query.limit)
  return toSummaries(q.all())
}

export function getNote(id: string): Note | null {
  const r = getDb().select(summaryCols).from(notes).where(eq(notes.id, id)).get()
  return r ? toSummaries([r])[0] : null
}

export function createNote(init?: { categoryId?: string | null; title?: string }): Note {
  const now = Date.now()
  const id = newId()
  getDb()
    .insert(notes)
    .values({
      id,
      title: init?.title ?? '',
      categoryId: init?.categoryId ?? null,
      learnedAt: now,
      docVersion: DOC_VERSION,
      editedAt: now,
      createdAt: now,
      updatedAt: now,
      updatedBy: deviceId()
    })
    .run()
  initDoc(id)
  recordActivity('note_create')
  return getNote(id)!
}

export function updateNote(id: string, patch: NoteMetaUpdate): NoteSummary {
  const db = getDb()
  const now = Date.now()
  const set: Partial<typeof notes.$inferSelect> = { updatedAt: now, updatedBy: deviceId() }
  for (const k of ['title', 'categoryId', 'pinned', 'learnedAt', 'status', 'supersededBy', 'aiExcluded'] as const) {
    if (patch[k] !== undefined) (set as Record<string, unknown>)[k] = patch[k]
  }
  if (patch.supersededBy === id) throw new Error('A note cannot supersede itself')
  // 被取代的知识自动标记为已过时
  if (patch.supersededBy) set.status = 'outdated'
  if (patch.title !== undefined) set.editedAt = now
  db.update(notes).set(set).where(eq(notes.id, id)).run()
  return getNote(id)!
}

export function trashNote(id: string): void {
  getDb().update(notes).set({ deletedAt: Date.now(), updatedAt: Date.now(), updatedBy: deviceId() }).where(eq(notes.id, id)).run()
}

export function deleteNoteRow(id: string): void {
  const db = getDb()
  db.delete(taggings).where(and(eq(taggings.entityType, 'note'), eq(taggings.entityId, id))).run()
  // 解除其他笔记对它的“被取代”引用
  db.update(notes).set({ supersededBy: null }).where(eq(notes.supersededBy, id)).run()
  db.delete(notes).where(eq(notes.id, id)).run()
}
