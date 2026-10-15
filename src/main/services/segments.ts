import { canReadSource } from './attachmentsAccess'
import { correctionPair, speakerBody } from '@shared/recording'
import { and, asc, eq, inArray, isNull, like } from 'drizzle-orm'
import { getDb, getSqlite } from '../db'
import { sourceSegments, segmentAliases, annotations, sources, recordings, hotwordCorrections } from '../db/schema'
import { newId } from '../lib/ids'
import { hashText } from '../lib/derive'
import { normalizeQuery } from '../lib/textNormalize'
import { emit } from '../events'
import type { Segment } from '@shared/types'

type Row = typeof sourceSegments.$inferSelect

const toSegment = (r: Row): Segment => ({
  id: r.id,
  sourceId: r.sourceId,
  ordinal: r.ordinal,
  kind: r.kind,
  locator: JSON.parse(r.locator) as Record<string, unknown>,
  text: r.text,
  heading: r.heading
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
export function getSegment(id: string, conversationId: string | null = null): Segment | null {
  const resolved = resolveSegmentId(id)
  if (!resolved) return null
  const row = getDb()
    .select({ segment: sourceSegments })
    .from(sourceSegments)
    .innerJoin(sources, eq(sourceSegments.sourceId, sources.id))
    .where(and(eq(sourceSegments.id, resolved), isNull(sources.deletedAt)))
    .get()
  if (
    !row ||
    !canReadSource(row.segment.sourceId, conversationId) ||
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
  heading?: string
}

/** 永久身份只解析到仍然存在的片段；内容权限由 getSegment 等读取入口再次检查。 */
export function resolveSegmentId(id: string): string | null {
  const db = getDb()
  if (db.select({ id: sourceSegments.id }).from(sourceSegments).where(eq(sourceSegments.id, id)).get()) return id
  return (
    db
      .select({ id: sourceSegments.id })
      .from(segmentAliases)
      .innerJoin(sourceSegments, eq(segmentAliases.newId, sourceSegments.id))
      .where(eq(segmentAliases.oldId, id))
      .get()?.id ?? null
  )
}

const segmentHash = (kind: string, heading: string, text: string): string =>
  heading ? hashText(kind, heading, text) : hashText(kind, text)
const bigrams = (text: string): Set<string> => {
  const chars = [...normalizeQuery(text)],
    out = new Set<string>()
  for (let i = 1; i < chars.length; i++) out.add(chars[i - 1] + chars[i])
  return out
}
function pageRange(locator: Record<string, unknown>): [number, number] | null {
  const page = Number(locator.page ?? (typeof locator.value === 'string' ? /(?:^|[,\s])page=(\d+)/.exec(locator.value)?.[1] : 0))
  if (!Number.isFinite(page) || page <= 0) return null
  return [page, Math.max(page, Number(locator.pageEnd) || page)]
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
    const next: { id: string; locator: Record<string, unknown>; grams: Set<string> }[] = []
    input.forEach((seg, ordinal) => {
      const heading = seg.heading ?? ''
      const hash = segmentHash(seg.kind, heading, seg.text)
      const reuse = byHash.get(hash)?.shift()
      const id = reuse?.id ?? newId()
      next.push({ id, locator: seg.locator, grams: bigrams(seg.text) })
      if (reuse) {
        kept.add(reuse.id)
        tx.update(sourceSegments)
          .set({ ordinal, locator: JSON.stringify(seg.locator), updatedAt: now })
          .where(eq(sourceSegments.id, reuse.id))
          .run()
      } else {
        tx.insert(sourceSegments)
          .values({
            id,
            sourceId,
            ordinal,
            kind: seg.kind,
            locator: JSON.stringify(seg.locator),
            text: seg.text,
            heading,
            hash,
            createdAt: now,
            updatedAt: now
          })
          .run()
      }
    })
    const dropped = prev.filter((r) => !kept.has(r.id))
    const remap = new Map<string, string>()
    // 倒排二字索引：只比较共享二字的新片段，长书升级时不在主进程做全量笛卡尔积。
    const ranges = next.map((c) => pageRange(c.locator)),
      postings = new Map<string, number[]>()
    next.forEach((c, i) =>
      c.grams.forEach((g) => {
        const list = postings.get(g)
        if (list) list.push(i)
        else postings.set(g, [i])
      })
    )
    // 已有别名一次读入，避免每个旧片段各扫一遍本资料的别名表。
    const aliasesTo = new Map<string, string[]>()
    if (dropped.length)
      for (const a of tx.select().from(segmentAliases).where(eq(segmentAliases.sourceId, sourceId)).all())
        aliasesTo.set(a.newId, [...(aliasesTo.get(a.newId) ?? []), a.oldId])
    for (const old of dropped) {
      const range = pageRange(JSON.parse(old.locator)),
        grams = bigrams(old.text),
        shared = new Map<number, number>()
      for (const g of grams) for (const i of postings.get(g) ?? []) shared.set(i, (shared.get(i) ?? 0) + 1)
      let index = -1,
        score = 0
      for (const [i, count] of shared) {
        const candidateRange = ranges[i]
        if (range && (!candidateRange || candidateRange[1] < range[0] || candidateRange[0] > range[1])) continue
        const similarity = count / grams.size
        // 同分取顺序靠前者，与逐个比较时的结果一致。
        if (similarity > score || (similarity === score && i < index)) {
          index = i
          score = similarity
        }
      }
      const best = index >= 0 ? next[index] : null
      if (!best || score < 0.3) continue
      const priors = aliasesTo.get(old.id) ?? []
      for (const prior of priors) remap.set(prior, best.id)
      if (priors.length)
        tx.update(segmentAliases)
          .set({ newId: best.id })
          .where(and(eq(segmentAliases.sourceId, sourceId), eq(segmentAliases.newId, old.id)))
          .run()
      tx.insert(segmentAliases)
        .values({ oldId: old.id, newId: best.id, sourceId, createdAt: now })
        .onConflictDoUpdate({ target: segmentAliases.oldId, set: { newId: best.id, sourceId, createdAt: now } })
        .run()
      remap.set(old.id, best.id)
    }
    // 批注是真实持久数据，与分段及别名一起提交；历史引用和导图在打开时解析。
    if (remap.size)
      for (const annotation of tx
        .select()
        .from(annotations)
        .where(and(eq(annotations.targetType, 'source'), eq(annotations.targetId, sourceId)))
        .all()) {
        const selector = JSON.parse(annotation.selector) as { ownerId?: string }
        const id = selector.ownerId && remap.get(selector.ownerId)
        if (id)
          tx.update(annotations)
            .set({ selector: JSON.stringify({ ...selector, ownerId: id }), updatedAt: now })
            .where(eq(annotations.id, annotation.id))
            .run()
      }
    const drop = dropped.map((r) => r.id)
    for (let i = 0; i < drop.length; i += 500)
      tx.delete(sourceSegments)
        .where(inArray(sourceSegments.id, drop.slice(i, i + 500)))
        .run()
  })
  emit('segments:changed', { sourceId })
  emit('annotations:changed', { targetType: 'source', targetId: sourceId })
  return input.length
}

export function deleteSegments(sourceId: string): void {
  getDb().transaction((tx) => {
    tx.delete(segmentAliases).where(eq(segmentAliases.sourceId, sourceId)).run()
    tx.delete(sourceSegments).where(eq(sourceSegments.sourceId, sourceId)).run()
  })
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
      .set({ text: clean, hash: segmentHash(row.kind, row.heading, clean), locator: JSON.stringify(locator), updatedAt: Date.now() })
      .where(eq(sourceSegments.id, id))
      .run()
  })
  emit('segments:changed', { sourceId: row.sourceId })
  return listSegments(row.sourceId).find((s) => s.id === id) ?? null
}
