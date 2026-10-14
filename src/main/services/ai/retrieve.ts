import { tablePreview } from '../../lib/attachmentText'
import { getSettings } from '../settings'
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { getDb, getSqlite } from '../../db'
import { annotations, assetTexts, noteAssetBlocks, blocks, chunks, notes, sourceSegments, sources } from '../../db/schema'
import type { ChatScope } from '@shared/schemas'
import type { KnowledgeStatus, SearchHit } from '@shared/types'
import { embed, isReady } from './embedding'
import { annotationText, vecBuffer } from './indexer'
import { ftsQuery } from '../../lib/fts'
import { lensKeywordSQL, lensVectorSQL } from '../../lib/lensRetrieval'
import type { RecordingFilters } from '@shared/lens'

// 混合检索：关键词（FTS5 trigram）+ 向量（sqlite-vec）→ RRF 融合 → 时间与可信度加权。
//   - 检索单位：笔记的康奈尔行 / 总结段落，资料的分段
//   - 隐私：“不发送给 AI”的笔记与资料、已删除内容一律排除
//   - 时间：已过时 ×0.55、存疑 ×0.85；AI 生成未审阅 ×0.85；最近修改的内容略微加分
//   - 每条结果都带学习日期、修改时间、状态与来源，供模型判断新旧冲突

const RRF_K = 60
const DAY = 86_400_000

type Key = string // `${ownerType}:${ownerId}`
/** 知识库入口只产生笔记和资料，网页命中由联网工具提供。 */
export type KnowledgeHit = SearchHit & { parentType: 'note' | 'source' }

function keywordHits(q: string, limit: number, filters: RecordingFilters = {}): Key[] {
  const fq = ftsQuery(q)
  const sqlite = getSqlite()
  if (Object.values(filters).some(Boolean)) {
    if (!fq) return []
    const filter = lensKeywordSQL(filters)
    return (sqlite.prepare(filter.sql).all(fq, ...filter.params, limit * 3) as { segment_id: string }[]).map(
      (r) => `segment:${r.segment_id}`
    )
  }
  const b = (
    fq ? sqlite.prepare('SELECT block_id FROM blocks_fts WHERE blocks_fts MATCH ? ORDER BY rank LIMIT ?').all(fq, limit * 3) : []
  ) as { block_id: string }[]
  const s = (
    fq ? sqlite.prepare('SELECT segment_id FROM segments_fts WHERE segments_fts MATCH ? ORDER BY rank LIMIT ?').all(fq, limit * 3) : []
  ) as { segment_id: string }[]
  // 段落命中归并到所在的康奈尔行（检索单位），总结段落保持自身
  const rows = b.length
    ? getDb()
        .select({ id: blocks.id, rowId: blocks.rowId, section: blocks.section })
        .from(blocks)
        .where(
          inArray(
            blocks.id,
            b.map((x) => x.block_id)
          )
        )
        .all()
    : []
  const byId = new Map(rows.map((r) => [r.id, r]))
  const keys: Key[] = []
  const seen = new Set<Key>()
  const push = (k: Key): void => {
    if (!seen.has(k)) {
      seen.add(k)
      keys.push(k)
    }
  }
  // 交替合并笔记与资料命中，避免某一类挤占
  for (let i = 0; i < Math.max(b.length, s.length); i++) {
    const r = b[i] && byId.get(b[i].block_id)
    if (r) push(`block:${r.section === 'row' || r.section === 'summary' ? r.id : (r.rowId ?? r.id)}`)
    if (s[i]) push(`segment:${s[i].segment_id}`)
  }
  // 批注（评论 / 提问）：表很小，直接按原句匹配
  const q2 = q.trim()
  if ([...q2].length >= 2 && [...q2].length <= 60) {
    const like = `%${q2.replace(/[%_]/g, '')}%`
    for (const a of sqlite
      .prepare('SELECT id FROM annotations WHERE deleted_at IS NULL AND body IS NOT NULL AND (body LIKE ? OR selector LIKE ?) LIMIT ?')
      .all(like, like, limit) as { id: string }[])
      push(`annotation:${a.id}`)
  }
  if (q.trim().length >= 2) {
    const like = `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    for (const r of sqlite
      .prepare(
        "SELECT r.id FROM note_asset_blocks r JOIN asset_texts t ON t.asset_id = r.asset_id JOIN notes n ON n.id = r.note_id WHERE n.deleted_at IS NULL AND n.ai_excluded = 0 AND t.text LIKE ? ESCAPE '\\' LIMIT ?"
      )
      .all(like, limit) as { id: string }[])
      push(`asset:${r.id}`)
  }
  return keys.slice(0, limit * 2)
}

interface VectorHits {
  keys: Key[]
  dist: Map<Key, number>
  qv: number[] | null
}
const noVectors = (): VectorHits => ({ keys: [], dist: new Map(), qv: null })
const clampSim = (sim: number): number => Math.max(0, Math.min(1, sim))

async function vectorHits(q: string, limit: number, filters: RecordingFilters = {}): Promise<VectorHits> {
  if (!(await isReady())) return noVectors()
  const [v] = await embed([q], 'query')
  if (!v?.length || v.some((n) => !Number.isFinite(n))) return noVectors()
  const filter = lensVectorSQL(filters),
    filtered = Object.values(filters).some(Boolean)
  const rows = (
    filtered
      ? getSqlite()
          .prepare(filter.sql)
          .all(vecBuffer(v), ...filter.params, limit * 3)
      : getSqlite()
          .prepare('SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance')
          .all(vecBuffer(v), limit * 3)
  ) as { rowid: number; distance: number }[]
  if (!rows.length) return { keys: [], dist: new Map(), qv: v }
  const meta = getDb()
    .select({ rowid: chunks.rowid, ownerType: chunks.ownerType, ownerId: chunks.ownerId })
    .from(chunks)
    .where(
      inArray(
        chunks.rowid,
        rows.map((r) => Number(r.rowid))
      )
    )
    .all()
  const byRow = new Map(meta.map((m) => [m.rowid, `${m.ownerType}:${m.ownerId}`]))
  const keys = rows.map((r) => byRow.get(Number(r.rowid))).filter((k): k is Key => !!k)
  const dist = new Map<Key, number>()
  for (const r of rows) {
    const key = byRow.get(Number(r.rowid))
    if (key && Number.isFinite(r.distance)) dist.set(key, Math.min(dist.get(key) ?? Infinity, r.distance))
  }
  return { keys, dist, qv: v }
}

/** 读取候选分片的内容与元数据（同时完成隐私与范围过滤） */
function hydrate(keys: Key[], scope: ChatScope, allow?: { sourceIds: string[] }): Map<Key, KnowledgeHit> {
  const db = getDb()
  const out = new Map<Key, KnowledgeHit>()
  const blockIds = keys.filter((k) => k.startsWith('block:')).map((k) => k.slice(6))
  const segIds = keys.filter((k) => k.startsWith('segment:')).map((k) => k.slice(8))
  const noteScope = scope.type === 'items' ? new Set(scope.notes) : null
  const srcScope = scope.type === 'items' ? new Set(scope.sources) : null

  const assetIds = keys.filter((k) => k.startsWith('asset:')).map((k) => k.slice(6))
  if (assetIds.length) {
    const rows = db
      .select({ ref: noteAssetBlocks, text: assetTexts.text, updatedAt: assetTexts.updatedAt, n: notes })
      .from(noteAssetBlocks)
      .innerJoin(assetTexts, eq(assetTexts.assetId, noteAssetBlocks.assetId))
      .innerJoin(notes, eq(notes.id, noteAssetBlocks.noteId))
      .where(and(inArray(noteAssetBlocks.id, assetIds), isNull(notes.deletedAt), eq(notes.aiExcluded, false)))
      .all()
    for (const r of rows) {
      if (noteScope && !noteScope.has(r.n.id)) continue
      out.set(`asset:${r.ref.id}`, {
        parentType: 'note',
        parentId: r.n.id,
        ownerId: r.ref.blockId,
        title: r.n.title,
        text: `［图片文字］${r.text}`,
        locator: null,
        score: 0,
        learnedAt: r.n.learnedAt,
        updatedAt: r.updatedAt,
        status: r.n.status as KnowledgeStatus,
        origin: 'user'
      })
    }
  }
  if (blockIds.length) {
    const rows = db
      .select({ b: blocks, n: notes })
      .from(blocks)
      .innerJoin(notes, eq(blocks.noteId, notes.id))
      .where(and(inArray(blocks.id, blockIds), isNull(blocks.deletedAt), isNull(notes.deletedAt), eq(notes.aiExcluded, false)))
      .all()
    for (const { b, n } of rows) {
      if (noteScope && !noteScope.has(n.id)) continue
      out.set(`block:${b.id}`, {
        parentType: 'note',
        parentId: n.id,
        ownerId: b.id,
        title: n.title,
        text: b.text,
        locator: null,
        score: 0,
        learnedAt: n.learnedAt,
        updatedAt: b.updatedAt,
        status: n.status as KnowledgeStatus,
        origin: b.origin
      })
    }
  }
  if (segIds.length) {
    const rows = db
      .select({ g: sourceSegments, s: sources })
      .from(sourceSegments)
      .innerJoin(sources, eq(sourceSegments.sourceId, sources.id))
      .where(
        and(
          inArray(sourceSegments.id, segIds),
          isNull(sources.deletedAt),
          or(
            eq(sources.aiExcluded, false),
            allow?.sourceIds.length ? and(eq(sources.space, 'attachment'), inArray(sources.id, allow.sourceIds)) : undefined
          )
        )
      )
      .all()
    for (const { g, s } of rows) {
      if (srcScope && !srcScope.has(s.id)) continue
      const loc = JSON.parse(g.locator) as Record<string, unknown>
      const limited = s.space === 'attachment' || !!allow?.sourceIds.includes(s.id)
      const preview = limited ? tablePreview([{ ...g, locator: loc }])[0] : null
      if (limited && !preview) continue
      out.set(`segment:${g.id}`, {
        parentType: 'source',
        parentId: s.id,
        ownerId: g.id,
        title: s.title,
        text: preview?.text ?? g.text,
        locator: typeof loc.value === 'string' ? loc.value : null,
        score: 0,
        learnedAt: s.publishedAt ?? s.accessedAt,
        updatedAt: s.accessedAt,
        status: null,
        origin: null
      })
    }
  }
  const annIds = keys.filter((k) => k.startsWith('annotation:')).map((k) => k.slice(11))
  if (annIds.length) {
    for (const a of db
      .select()
      .from(annotations)
      .where(and(inArray(annotations.id, annIds), isNull(annotations.deletedAt)))
      .all()) {
      if (!a.body?.trim()) continue
      const sel = JSON.parse(a.selector) as { quote?: string; page?: number; ownerId?: string | null }
      const t =
        a.targetType === 'note'
          ? db
              .select({ title: notes.title, d: notes.deletedAt, x: notes.aiExcluded, l: notes.learnedAt })
              .from(notes)
              .where(eq(notes.id, a.targetId))
              .get()
          : db
              .select({ title: sources.title, d: sources.deletedAt, x: sources.aiExcluded, l: sources.accessedAt })
              .from(sources)
              .where(eq(sources.id, a.targetId))
              .get()
      if (!t || t.d || t.x) continue
      if (a.targetType === 'note' ? noteScope && !noteScope.has(a.targetId) : srcScope && !srcScope.has(a.targetId)) continue
      out.set(`annotation:${a.id}`, {
        parentType: a.targetType,
        parentId: a.targetId,
        // 引用跳转到批注所在的片段 / 段落
        ownerId: sel.ownerId ?? a.id,
        title: t.title,
        text: annotationText(a.motivation, a.body, sel.quote),
        locator: sel.page ? `page=${sel.page}` : null,
        score: 0,
        learnedAt: t.l,
        updatedAt: a.updatedAt,
        status: null,
        origin: 'user'
      })
    }
  }
  return out
}

export function weight(h: SearchHit): number {
  let w = 1
  if (h.status === 'outdated') w *= 0.55
  else if (h.status === 'disputed') w *= 0.85
  if (h.origin === 'ai') w *= 0.85
  // 最近修改的内容略微加分（半衰期约半年，最多 +15%）
  if (h.updatedAt) w *= 1 + 0.15 * Math.exp(-(Date.now() - h.updatedAt) / (180 * DAY))
  return w
}

/** 检索知识库，返回按相关度与时间加权排序的片段 */
/**
 * prefer：用户正在看的资料（v0.7.6）——同等相关时优先它的片段，问“这本书里……”时不被别的资料挤掉
 */
export async function retrieve(
  query: string,
  scope: ChatScope,
  limit = 8,
  filters: RecordingFilters = {},
  prefer?: string | null,
  allow?: { sourceIds: string[] }
): Promise<KnowledgeHit[]> {
  if (scope.type === 'none' || !query.trim()) return []
  const privateAllowed =
    allow?.sourceIds.length &&
    getDb()
      .select({ id: sources.id })
      .from(sources)
      .where(and(inArray(sources.id, allow.sourceIds), eq(sources.space, 'attachment')))
      .get()
  const onlyKeywords = !!privateAllowed && getSettings().ai.embedding?.mode === 'cloud'
  const [kw, vec] = await Promise.all([
    Promise.resolve(keywordHits(query, limit, filters)),
    onlyKeywords ? Promise.resolve(noVectors()) : vectorHits(query, limit, filters).catch(noVectors)
  ])
  const rrf = new Map<Key, number>()
  kw.forEach((k, i) => rrf.set(k, (rrf.get(k) ?? 0) + 1 / (RRF_K + i)))
  // 向量命中权重略高：语义相关比字面重合更可靠
  vec.keys.forEach((k, i) => rrf.set(k, (rrf.get(k) ?? 0) + 1.2 / (RRF_K + i)))
  const hits = hydrate([...rrf.keys()], scope, allow)
  const kwSet = new Set(kw)
  const vecSet = new Set(vec.keys)
  const via = (k: Key): SearchHit['via'] => (kwSet.has(k) && vecSet.has(k) ? 'both' : vecSet.has(k) ? 'semantic' : 'keyword')
  const finalHits = [...hits.entries()]
    .map(([k, h]) => ({
      ...h,
      via: via(k),
      score: (rrf.get(k) ?? 0) * weight(h) * (prefer && h.parentId === prefer ? 1.6 : 1),
      ...(vec.dist.has(k) ? { sim: clampSim(1 - vec.dist.get(k)!) } : {})
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  // 先完成隐私、范围和数量筛选，再批量补算；补算失败不改变原有排名与结果。
  const missing = finalHits.filter((h) => h.sim === undefined)
  if (vec.qv && missing.length) {
    try {
      const qv = vec.qv
      const vectors = await embed(
        missing.map((h) => h.text),
        'doc',
        missing.map((h) => h.title)
      )
      for (let i = 0; i < missing.length; i++) {
        const v = vectors[i]
        if (v?.length === qv.length && v.every(Number.isFinite)) missing[i].sim = clampSim(qv.reduce((sum, n, j) => sum + n * v[j], 0))
      }
    } catch {
      /* 相似度是附加元数据，向量失败时保留关键词结果。 */
    }
  }
  return finalHits
}

/**
 * 与一段文字语义相近的笔记 / 资料片段：只用本地向量，带相似度门槛（余弦相似度），宁缺毋滥。
 * 用于浏览器的“相关笔记”旁注（v0.6.0）——不调用大模型、不花钱。
 */
// 收件箱需要不同的可写笔记：先按有效分片筛选，再按整篇笔记聚合距离，避免资料和重复分片挤占名额。
export const CORNELL_SIMILARITY_SQL = `
  SELECT rowid, note_distance AS distance FROM (
  SELECT v.rowid, MIN(vec_distance_cosine(v.embedding, ?)) AS note_distance
  FROM vec_chunks v
  JOIN chunks c ON c.rowid = v.rowid
  JOIN notes n ON n.id = c.parent_id
  WHERE c.parent_type = 'note' AND n.kind = 'cornell'
    AND n.deleted_at IS NULL AND n.ai_excluded = 0
    AND (
      (c.owner_type = 'block' AND EXISTS (SELECT 1 FROM blocks b WHERE b.id = c.owner_id AND b.deleted_at IS NULL))
      OR (c.owner_type = 'asset' AND EXISTS (
        SELECT 1 FROM note_asset_blocks r JOIN asset_texts t ON t.asset_id = r.asset_id WHERE r.id = c.owner_id
      ))
      OR (c.owner_type = 'annotation' AND EXISTS (
        SELECT 1 FROM annotations a WHERE a.id = c.owner_id AND a.deleted_at IS NULL AND TRIM(COALESCE(a.body, '')) != ''
      ))
    )
  GROUP BY c.parent_id
  ) WHERE note_distance <= ?
  ORDER BY note_distance
  LIMIT ?`

export async function similarTo(
  text: string,
  scope: ChatScope,
  limit: number,
  minSim: number,
  options?: { distinctCornellNotes?: boolean; guard?: () => void }
): Promise<(KnowledgeHit & { sim: number })[]> {
  if (!text.trim() || !(await isReady())) return []
  options?.guard?.()
  const [v] = await embed([text.slice(0, 2000)], 'doc')
  options?.guard?.()
  const rows = (
    options?.distinctCornellNotes
      ? getSqlite()
          .prepare(CORNELL_SIMILARITY_SQL)
          .all(vecBuffer(v), 1 - minSim, limit)
      : getSqlite()
          .prepare('SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ? ORDER BY distance')
          .all(vecBuffer(v), limit * 4)
  ) as { rowid: number; distance: number }[]
  const good = rows.filter((r) => 1 - r.distance >= minSim)
  if (!good.length) return []
  const meta = getDb()
    .select({ rowid: chunks.rowid, ownerType: chunks.ownerType, ownerId: chunks.ownerId })
    .from(chunks)
    .where(
      inArray(
        chunks.rowid,
        good.map((r) => Number(r.rowid))
      )
    )
    .all()
  const simOf = new Map(good.map((r) => [Number(r.rowid), 1 - r.distance]))
  const keyed = meta.map((m) => ({ key: `${m.ownerType}:${m.ownerId}` as Key, sim: simOf.get(m.rowid) ?? 0 }))
  const hits = hydrate(
    keyed.map((k) => k.key),
    scope
  )
  return keyed
    .filter((k) => hits.has(k.key))
    .map((k) => ({ ...hits.get(k.key)!, score: k.sim, sim: k.sim }))
    .sort((a, b) => b.sim - a.sim)
}
