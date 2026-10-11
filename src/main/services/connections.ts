import { and, eq, inArray, isNull, isNotNull, or } from 'drizzle-orm'
import { getDb, getSqlite } from '../db'
import { assetTexts, noteAssetBlocks, blocks, chunks, links, notes, sources } from '../db/schema'
import { newId } from '../lib/ids'
import { emit } from '../events'
import type { NoteConnections } from '@shared/types'
import { deviceId } from './device'
import { isReady } from './ai/embedding'
import { setTextLink } from './docs'

// 双向链接（v0.5.0）：链接到这里（反向链接）、手动关联、相关笔记推荐（本地向量）、未链接的提及。
// 正文中的 [[链接]] 在派生时写入 links（origin = doc）；“关联”是 origin = manual、relation = related 的链接，双向显示。
// “不相关”记为一条已删除（deleted_at）的手动关联：此后不再推荐。设计见 docs/design/v0.5-knowledge-structure.md §2。

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s)

function noteTitle(id: string): { title: string; ok: boolean } {
  const n = getDb().select({ title: notes.title, deletedAt: notes.deletedAt }).from(notes).where(eq(notes.id, id)).get()
  return { title: n?.title ?? '', ok: !!n && !n.deletedAt }
}
function sourceTitle(id: string): { title: string; ok: boolean } {
  const s = getDb().select({ title: sources.title, deletedAt: sources.deletedAt }).from(sources).where(eq(sources.id, id)).get()
  return { title: s?.title ?? '', ok: !!s && !s.deletedAt }
}
const titleOf = (type: 'note' | 'source', id: string): { title: string; ok: boolean } => (type === 'note' ? noteTitle(id) : sourceTitle(id))

/** 关联关系（双向）：本篇建立的和指向本篇的手动关联；dismissed 包含被标为“不相关”的 */
function manualLinks(noteId: string, includeDeleted = false) {
  return getDb()
    .select()
    .from(links)
    .where(
      and(
        eq(links.origin, 'manual'),
        eq(links.relation, 'related'),
        or(and(eq(links.fromType, 'note'), eq(links.fromId, noteId)), and(eq(links.toType, 'note'), eq(links.toId, noteId))),
        includeDeleted ? undefined : isNull(links.deletedAt)
      )
    )
    .all()
}

/** 相关笔记推荐：用本篇各段落的向量找最近的其他笔记 / 资料，按命中排名累计得分 */
async function relatedByVectors(noteId: string, exclude: Set<string>): Promise<NoteConnections['related']> {
  if (!(await isReady().catch(() => false))) return []
  const mine = getDb()
    .select({ rowid: chunks.rowid, ownerId: chunks.ownerId, ownerType: chunks.ownerType })
    .from(chunks)
    .where(and(eq(chunks.parentType, 'note'), eq(chunks.parentId, noteId)))
    .limit(16)
    .all()
  if (!mine.length) return []
  const sqlite = getSqlite()
  const getVec = sqlite.prepare('SELECT embedding FROM vec_chunks WHERE rowid = ?')
  const near = sqlite.prepare('SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance')
  type Acc = { type: 'note' | 'source'; id: string; score: number; best: number; mine: string; theirs: string }
  const acc = new Map<string, Acc>()
  const ownerText = (type: string, id: string): string => {
    if (type === 'asset')
      return (
        getDb()
          .select({ text: assetTexts.text })
          .from(noteAssetBlocks)
          .innerJoin(assetTexts, eq(assetTexts.assetId, noteAssetBlocks.assetId))
          .innerJoin(notes, eq(notes.id, noteAssetBlocks.noteId))
          .where(and(eq(noteAssetBlocks.id, id), isNull(notes.deletedAt), eq(notes.aiExcluded, false)))
          .get()?.text ?? ''
      )
    if (type === 'block') return getDb().select({ text: blocks.text }).from(blocks).where(eq(blocks.id, id)).get()?.text ?? ''
    return (sqlite.prepare('SELECT text FROM source_segments WHERE id = ?').get(id) as { text: string } | undefined)?.text ?? ''
  }
  for (const m of mine) {
    const v = getVec.get(BigInt(m.rowid)) as { embedding: Buffer } | undefined
    if (!v) continue
    const hits = near.all(v.embedding, 20) as { rowid: number; distance: number }[]
    const meta = getDb()
      .select({
        rowid: chunks.rowid,
        ownerType: chunks.ownerType,
        ownerId: chunks.ownerId,
        parentType: chunks.parentType,
        parentId: chunks.parentId
      })
      .from(chunks)
      .where(
        inArray(
          chunks.rowid,
          hits.map((h) => Number(h.rowid))
        )
      )
      .all()
    const byRow = new Map(meta.map((x) => [x.rowid, x]))
    let rank = 0
    for (const h of hits) {
      const x = byRow.get(Number(h.rowid))
      if (!x || x.parentId === noteId) continue
      const key = `${x.parentType}:${x.parentId}`
      if (exclude.has(key)) continue
      rank++
      const a = acc.get(key) ?? { type: x.parentType, id: x.parentId, score: 0, best: Infinity, mine: '', theirs: '' }
      a.score += 1 / (rank + 1)
      if (h.distance < a.best) {
        a.best = h.distance
        a.mine = `${m.ownerType}:${m.ownerId}`
        a.theirs = `${x.ownerType}:${x.ownerId}`
      }
      acc.set(key, a)
    }
  }
  const ranked = [...acc.values()].sort((a, b) => b.score - a.score)
  const top = ranked[0]?.score ?? 0
  return ranked
    .filter((a) => a.score >= top * 0.35)
    .slice(0, 6)
    .map((a) => {
      const t = titleOf(a.type, a.id)
      const at = a.theirs.indexOf(':')
      const ot = a.theirs.slice(0, at),
        oid = a.theirs.slice(at + 1)
      const mineAt = a.mine.indexOf(':')
      return t.ok
        ? {
            type: a.type,
            id: a.id,
            title: t.title,
            score: Math.round(a.score * 100) / 100,
            mine: clip(ownerText(a.mine.slice(0, mineAt), a.mine.slice(mineAt + 1)), 140),
            theirs: clip(ownerText(ot, oid), 140)
          }
        : null
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
}

/** 未链接的提及：正文出现了本篇标题、但还没有链接或关联的笔记 */
function unlinkedMentions(noteId: string, title: string, exclude: Set<string>): NoteConnections['mentions'] {
  const t = title.trim()
  if ([...t].length < 2) return []
  const sqlite = getSqlite()
  const ids =
    [...t].length >= 3
      ? (
          sqlite.prepare('SELECT note_id FROM notes_fts WHERE plain_text MATCH ? LIMIT 50').all(`"${t.replace(/"/g, '""')}"`) as {
            note_id: string
          }[]
        ).map((r) => r.note_id)
      : (
          sqlite.prepare('SELECT id AS note_id FROM notes WHERE deleted_at IS NULL AND plain_text LIKE ? LIMIT 50').all(`%${t}%`) as {
            note_id: string
          }[]
        ).map((r) => r.note_id)
  const out: NoteConnections['mentions'] = []
  for (const id of ids) {
    if (id === noteId || exclude.has(`note:${id}`)) continue
    const n = noteTitle(id)
    if (!n.ok) continue
    const b = getDb()
      .select({ id: blocks.id, text: blocks.text })
      .from(blocks)
      .where(and(eq(blocks.noteId, id), isNull(blocks.deletedAt)))
      .all()
      .find((x) => x.text.includes(t) && x.id)
    if (!b) continue
    const i = b.text.indexOf(t)
    out.push({ noteId: id, title: n.title, blockId: b.id, text: clip(b.text.slice(Math.max(0, i - 40)), 160) })
    if (out.length >= 10) break
  }
  return out
}

export async function noteConnections(noteId: string): Promise<NoteConnections> {
  const db = getDb()
  const me = noteTitle(noteId)
  // 链接到这里：正文中的链接（引用）
  const back = db
    .select({ fromId: links.fromId, fromBlockId: links.fromBlockId })
    .from(links)
    .where(
      and(eq(links.toType, 'note'), eq(links.toId, noteId), eq(links.fromType, 'note'), eq(links.origin, 'doc'), isNull(links.deletedAt))
    )
    .all()
  const backlinks: NoteConnections['backlinks'] = []
  const seen = new Set<string>()
  for (const l of back) {
    if (l.fromId === noteId || seen.has(`${l.fromId}:${l.fromBlockId}`)) continue
    seen.add(`${l.fromId}:${l.fromBlockId}`)
    const n = noteTitle(l.fromId)
    if (!n.ok) continue
    const b = l.fromBlockId ? db.select({ text: blocks.text }).from(blocks).where(eq(blocks.id, l.fromBlockId)).get() : undefined
    backlinks.push({ noteId: l.fromId, title: n.title, blockId: l.fromBlockId, text: clip(b?.text ?? '', 160) })
  }
  // 本篇正文链接出去的
  const outgoing = new Set(
    db
      .select({ toType: links.toType, toId: links.toId })
      .from(links)
      .where(and(eq(links.fromType, 'note'), eq(links.fromId, noteId), eq(links.origin, 'doc'), isNull(links.deletedAt)))
      .all()
      .map((l) => `${l.toType}:${l.toId}`)
  )
  // 手动关联（双向）
  const manualAll = manualLinks(noteId, true)
  const related: NoteConnections['linked'] = []
  for (const l of manualAll) {
    if (l.deletedAt) continue
    const other =
      l.fromType === 'note' && l.fromId === noteId
        ? { type: l.toType as 'note' | 'source', id: l.toId }
        : { type: l.fromType as 'note' | 'source', id: l.fromId }
    const t = titleOf(other.type, other.id)
    if (t.ok) related.push({ linkId: l.id, type: other.type, id: other.id, title: t.title })
  }
  const exclude = new Set<string>([
    ...outgoing,
    ...backlinks.map((b) => `note:${b.noteId}`),
    ...manualAll.map((l) => (l.fromType === 'note' && l.fromId === noteId ? `${l.toType}:${l.toId}` : `${l.fromType}:${l.fromId}`))
  ])
  return {
    backlinks,
    linked: related,
    related: await relatedByVectors(noteId, exclude),
    mentions: unlinkedMentions(noteId, me.title, exclude),
    vectors: await isReady().catch(() => false)
  }
}

/** 建立关联（手动、双向可见） */
export function relate(noteId: string, toType: 'note' | 'source', toId: string): void {
  if (toType === 'note' && toId === noteId) return
  const db = getDb()
  const now = Date.now()
  const existing = manualLinks(noteId, true).find(
    (l) =>
      (l.fromId === noteId && l.toType === toType && l.toId === toId) || (l.toId === noteId && l.fromType === toType && l.fromId === toId)
  )
  if (existing) db.update(links).set({ deletedAt: null, updatedAt: now }).where(eq(links.id, existing.id)).run()
  else
    db.insert(links)
      .values({
        id: newId(),
        fromType: 'note',
        fromId: noteId,
        toType,
        toId,
        relation: 'related',
        origin: 'manual',
        createdAt: now,
        updatedAt: now,
        updatedBy: deviceId()
      })
      .run()
  emit('notes:changed', { ids: [noteId, ...(toType === 'note' ? [toId] : [])] })
}

/** 取消关联 / 标为不相关：软删除（以后不再推荐） */
export function unrelate(noteId: string, toType: 'note' | 'source', toId: string): void {
  const db = getDb()
  const now = Date.now()
  const existing = manualLinks(noteId, true).find(
    (l) =>
      (l.fromId === noteId && l.toType === toType && l.toId === toId) || (l.toId === noteId && l.fromType === toType && l.fromId === toId)
  )
  if (existing) db.update(links).set({ deletedAt: now, updatedAt: now }).where(eq(links.id, existing.id)).run()
  else
    db.insert(links)
      .values({
        id: newId(),
        fromType: 'note',
        fromId: noteId,
        toType,
        toId,
        relation: 'related',
        origin: 'manual',
        createdAt: now,
        updatedAt: now,
        deletedAt: now,
        updatedBy: deviceId()
      })
      .run()
  emit('notes:changed', { ids: [noteId, ...(toType === 'note' ? [toId] : [])] })
}

/** 知识结构图用：全部未删除的笔记间 / 笔记到资料的关系 */
export function allEdges(): { from: string; to: string; kind: 'reference' | 'related' | 'source' }[] {
  return getDb()
    .select({
      fromType: links.fromType,
      fromId: links.fromId,
      toType: links.toType,
      toId: links.toId,
      origin: links.origin,
      relation: links.relation
    })
    .from(links)
    .where(and(isNull(links.deletedAt), eq(links.fromType, 'note'), isNotNull(links.toId)))
    .all()
    .filter((l) => l.toType === 'note' || l.toType === 'source')
    .map((l) => ({
      from: `note:${l.fromId}`,
      to: `${l.toType}:${l.toId}`,
      kind: l.toType === 'source' ? ('source' as const) : l.origin === 'manual' ? ('related' as const) : ('reference' as const)
    }))
}

/**
 * 把“提及”变成链接：在提到本篇标题的那篇笔记里，给标题文字加上指向本篇的链接（undo 为去掉）。
 * 派生后自然成为反向链接。
 */
export function linkMention(noteId: string, mentionNoteId: string, blockId: string, undo = false): boolean {
  const me = noteTitle(noteId)
  if (!me.ok || !me.title.trim()) return false
  return setTextLink(mentionNoteId, blockId, me.title.trim(), undo ? null : `jiwei://note/${noteId}`)
}

/** 与某份资料关联的笔记（手动关联、正文里引用了它）：资料起始页上“接着写”（v0.7.6） */
export function notesForSource(sourceId: string): { id: string; title: string; updatedAt: number }[] {
  return getSqlite()
    .prepare(
      `SELECT DISTINCT n.id, n.title, n.updated_at AS updatedAt FROM links l JOIN notes n ON n.id = l.from_id
       WHERE l.from_type = 'note' AND l.to_type = 'source' AND l.to_id = ? AND l.deleted_at IS NULL AND n.deleted_at IS NULL
       ORDER BY n.updated_at DESC LIMIT 20`
    )
    .all(sourceId) as { id: string; title: string; updatedAt: number }[]
}
