import { correctionPair, speakerBody } from '@shared/recording'
import { and, asc, eq, inArray, isNull, like } from 'drizzle-orm'
import { getDb, getSqlite } from '../db'
import { sourceSegments, sources, recordings, hotwordCorrections } from '../db/schema'
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

/** 按永久片段身份定位；智能界面不能借此读取已排除或删除的资料。 */
export function getSegment(id: string): Segment | null {
  const row = getDb()
    .select({ segment: sourceSegments })
    .from(sourceSegments)
    .innerJoin(sources, eq(sourceSegments.sourceId, sources.id))
    .where(and(eq(sourceSegments.id, id), isNull(sources.deletedAt), eq(sources.aiExcluded, false)))
    .get()
  if (
    !row ||
    getDb()
      .select({ id: recordings.id })
      .from(recordings)
      .where(and(eq(recordings.sourceId, row.segment.sourceId), eq(recordings.localOnly, true)))
      .get()
  )
    return null
  return toSegment(row.segment)
}

/** 资料正文检索：≥3 字用 FTS5 trigram，否则回退 LIKE；排除已删除资料 */
export function searchSegments(query: string, sourceId?: string): Segment[] {
  const q = query.trim()
  const live = getDb()
    .select({ id: sources.id })
    .from(sources)
    .where(and(isNull(sources.deletedAt), sourceId ? eq(sources.id, sourceId) : eq(sources.space, 'library')))
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
  const conds = [inArray(sourceSegments.sourceId, live)]
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

/** 修改单个片段的文字（如纠正转写错误）；位置不变，ID 不变（引用与就地提问不受影响） */
export function updateSegmentText(id: string, text: string): Segment | null {
  const db = getDb()
  const row = db.select().from(sourceSegments).where(eq(sourceSegments.id, id)).get()
  if (!row) return null
  let clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('内容不能为空')
  const locator = JSON.parse(row.locator) as Record<string, unknown>
  db.transaction(() => {
    if (row.kind === 'transcript') {
      const prefix = locator.speaker ? /^［[^］]+］/.exec(row.text)?.[0] : null
      if (prefix && !clean.startsWith(prefix)) clean = prefix + clean
      locator.edited = true
      const pair = correctionPair(speakerBody(row.text), speakerBody(clean))
      if (pair) {
        const existing = db
          .select()
          .from(hotwordCorrections)
          .where(and(eq(hotwordCorrections.from, pair.from), eq(hotwordCorrections.to, pair.to)))
          .get()
        if (existing)
          db.update(hotwordCorrections)
            .set({ count: existing.count + 1, lastUsedAt: Date.now() })
            .where(eq(hotwordCorrections.id, existing.id))
            .run()
        else
          db.insert(hotwordCorrections)
            .values({ id: newId(), ...pair, count: 1, lastUsedAt: Date.now() })
            .run()
      }
    }
    db.update(sourceSegments)
      .set({ text: clean, hash: hashText(row.kind, clean), locator: JSON.stringify(locator), updatedAt: Date.now() })
      .where(eq(sourceSegments.id, id))
      .run()
  })
  emit('segments:changed', { sourceId: row.sourceId })
  return listSegments(row.sourceId).find((s) => s.id === id) ?? null
}
