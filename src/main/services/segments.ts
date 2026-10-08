import { and, asc, eq, inArray, isNull, like } from 'drizzle-orm'
import { getDb, getSqlite } from '../db'
import { sourceSegments, sources } from '../db/schema'
import { newId } from '../lib/ids'
import { hashText } from '../lib/derive'
import { emit } from '../events'
import type { Segment } from '@shared/types'

type Row = typeof sourceSegments.$inferSelect

const toSegment = (r: Row): Segment => ({
  id: r.id,
  sourceId: r.sourceId,
  ordinal: r.ordinal,
  kind: r.kind,
  locator: JSON.parse(r.locator) as Record<string, unknown>,
  text: r.text
})

export function listSegments(sourceId: string): Segment[] {
  return getDb()
    .select()
    .from(sourceSegments)
    .where(eq(sourceSegments.sourceId, sourceId))
    .orderBy(asc(sourceSegments.ordinal))
    .all()
    .map(toSegment)
}

/** 资料正文检索：≥3 字用 FTS5 trigram，否则回退 LIKE；排除已删除资料 */
export function searchSegments(query: string, sourceId?: string): Segment[] {
  const q = query.trim()
  const live = getDb()
    .select({ id: sources.id })
    .from(sources)
    .where(isNull(sources.deletedAt))
    .all()
    .map((r) => r.id)
  if (live.length === 0) return []
  let ids: string[]
  if ([...q].length >= 3) {
    const rows = getSqlite()
      .prepare('SELECT segment_id FROM segments_fts WHERE segments_fts MATCH ? ORDER BY rank LIMIT 200')
      .all('"' + q.replace(/"/g, '""') + '"') as { segment_id: string }[]
    ids = rows.map((r) => r.segment_id)
    if (ids.length === 0) return []
  } else {
    ids = []
  }
  const conds = [inArray(sourceSegments.sourceId, sourceId ? [sourceId] : live)]
  if (ids.length) conds.push(inArray(sourceSegments.id, ids))
  else conds.push(like(sourceSegments.text, `%${q}%`))
  return getDb()
    .select()
    .from(sourceSegments)
    .where(and(...conds))
    .limit(200)
    .all()
    .map(toSegment)
}

export interface SegmentInput {
  kind: string
  locator: Record<string, unknown>
  text: string
}

/**
 * 用新的分段结果替换资料的全部分段。
 * 内容相同的分段沿用原 ID（按顺序与哈希匹配），保证批注与引用不会因重新解析而失效。
 */
export function replaceSegments(sourceId: string, input: SegmentInput[]): number {
  const db = getDb()
  const now = Date.now()
  const prev = db.select().from(sourceSegments).where(eq(sourceSegments.sourceId, sourceId)).all()
  const byHash = new Map<string, Row[]>()
  for (const r of prev) byHash.set(r.hash, [...(byHash.get(r.hash) ?? []), r])
  db.transaction((tx) => {
    const kept = new Set<string>()
    input.forEach((seg, ordinal) => {
      const hash = hashText(seg.kind, seg.text)
      const reuse = byHash.get(hash)?.shift()
      if (reuse) {
        kept.add(reuse.id)
        tx.update(sourceSegments)
          .set({ ordinal, locator: JSON.stringify(seg.locator), updatedAt: now })
          .where(eq(sourceSegments.id, reuse.id))
          .run()
      } else {
        tx.insert(sourceSegments)
          .values({
            id: newId(),
            sourceId,
            ordinal,
            kind: seg.kind,
            locator: JSON.stringify(seg.locator),
            text: seg.text,
            hash,
            createdAt: now,
            updatedAt: now
          })
          .run()
      }
    })
    const drop = prev.filter((r) => !kept.has(r.id)).map((r) => r.id)
    for (let i = 0; i < drop.length; i += 500)
      tx.delete(sourceSegments)
        .where(inArray(sourceSegments.id, drop.slice(i, i + 500)))
        .run()
  })
  emit('segments:changed', { sourceId })
  return input.length
}

export function deleteSegments(sourceId: string): void {
  getDb().delete(sourceSegments).where(eq(sourceSegments.sourceId, sourceId)).run()
}
