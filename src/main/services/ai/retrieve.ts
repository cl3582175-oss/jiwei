import { listSegments } from '../segments'
import { tablePreview } from '../../lib/attachmentText'
import { getSettings } from '../settings'
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { getDb, getSqlite } from '../../db'
import { annotations, assetTexts, noteAssetBlocks, blocks, chunks, notes, sourceSegments, sources } from '../../db/schema'
import type { ChatScope } from '@shared/schemas'
import type { KnowledgeStatus, SearchHit } from '@shared/types'
import { embed, isReady } from './embedding'
import { annotationText, vecBuffer } from './indexer'
import { normalizeQuery } from '../../lib/textNormalize'
import { embeddingText } from '../../lib/chunker'
import { matchSourcesByTitle } from './sourceMentions'
import {
  RETRIEVAL,
  candidateScope,
  routedScope,
  keywordCandidates,
  shortCandidates,
  exactCandidates,
  vectorCandidates,
  noVectors,
  type RetrievalOptions
} from './retrievalCandidates'
export { RETRIEVAL } from './retrievalCandidates'
export type { RetrievalOptions } from './retrievalCandidates'
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

const clampSim = (sim: number): number => Math.max(0, Math.min(1, sim))

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
    const previews = new Map<string, Map<string, string>>()
    const rows = db
      .select({ g: sourceSegments, s: sources })
      .from(sourceSegments)
      .innerJoin(sources, eq(sourceSegments.sourceId, sources.id))
      .where(
        and(
          inArray(sourceSegments.id, segIds),
          isNull(sources.deletedAt),
          or(
            and(eq(sources.space, 'library'), eq(sources.aiExcluded, false)),
            allow?.sourceIds.length ? and(eq(sources.space, 'attachment'), inArray(sources.id, allow.sourceIds)) : undefined
          )
        )
      )
      .all()
    for (const { g, s } of rows) {
      if (srcScope && !srcScope.has(s.id)) continue
      const loc = JSON.parse(g.locator) as Record<string, unknown>
      const limited = s.space === 'attachment' || !!allow?.sourceIds.includes(s.id)
      if (limited && g.kind === 'table' && !previews.has(s.id))
        previews.set(s.id, new Map(tablePreview(listSegments(s.id)).map((g) => [g.id, g.text])))
      const text = limited && g.kind === 'table' ? previews.get(s.id)?.get(g.id) : g.text
      if (text === undefined) continue
      out.set(`segment:${g.id}`, {
        parentType: 'source',
        parentId: s.id,
        webOrigin: s.webOrigin ?? undefined,
        ownerId: g.id,
        title: s.title,
        text,
        heading: g.heading,
        ...(typeof loc.pageEnd === 'number' ? { pageEnd: loc.pageEnd } : {}),
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
              .select({ title: sources.title, d: sources.deletedAt, x: sources.aiExcluded, l: sources.accessedAt, space: sources.space })
              .from(sources)
              .where(eq(sources.id, a.targetId))
              .get()
      if (!t || t.d !== null || t.x || ('space' in t && t.space !== 'library')) continue
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
const trigrams = (text: string): Set<string> => {
  const chars = [...normalizeQuery(text)],
    grams = new Set<string>()
  for (let i = 2; i < chars.length; i++) grams.add(chars.slice(i - 2, i + 1).join(''))
  return grams
}
const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size && !b.size) return 1
  const intersection = [...a].filter((x) => b.has(x)).length
  return intersection / (a.size + b.size - intersection)
}

export async function retrieve(
  query: string,
  scope: ChatScope,
  limit = 8,
  filters: RecordingFilters = {},
  prefer?: string | null,
  allow?: { sourceIds: string[] },
  opts: RetrievalOptions = {}
): Promise<KnowledgeHit[]> {
  query = normalizeQuery(query)
  const priorityIds = opts.priorityIds ?? { notes: [], sources: [] }
  const priority = new Set([...priorityIds.notes.map((id) => 'note:' + id), ...priorityIds.sources.map((id) => 'source:' + id)])
  if ((scope.type === 'none' && !priority.size) || !query || limit <= 0) return []
  const base = candidateScope(scope, filters, allow, opts)
  base.excludeNotes = priorityIds.notes
  base.excludeSources = priorityIds.sources
  const matches = !base.restricted ? matchSourcesByTitle(query, scope) : []
  const routedIds = new Set(matches.map((m) => m.sourceId))
  const routes = [
    ...(priority.size ? [{ ctx: candidateScope({ type: 'items', ...priorityIds }, filters, allow), boost: 1 }] : []),
    ...(scope.type !== 'none'
      ? [{ ctx: base, boost: 1 }, ...(matches.length ? [{ ctx: routedScope(base, [...routedIds]), boost: 1.5 }] : [])]
      : [])
  ]
  const privateAllowed =
    allow?.sourceIds.length &&
    getDb()
      .select({ id: sources.id })
      .from(sources)
      .where(and(inArray(sources.id, allow.sourceIds), eq(sources.space, 'attachment')))
      .get()
  const onlyKeywords = !!privateAllowed && getSettings().ai.embedding?.mode === 'cloud'
  const candidateLists = routes.map((route) => ({
    ...route,
    kw: keywordCandidates(query, route.ctx),
    short: shortCandidates(query, route.ctx),
    exact: exactCandidates(query, route.ctx)
  }))
  let qv: number[] | null = null
  if (!onlyKeywords)
    try {
      if (await isReady()) {
        const [v] = await embed([query], 'query')
        if (v?.length && v.every(Number.isFinite)) qv = v
      }
    } catch {
      /* 关键词在向量不可用时照常工作。 */
    }
  const scores = new Map<Key, number>(),
    kwSet = new Set<Key>(),
    vecSet = new Set<Key>(),
    dist = new Map<Key, number>()
  for (const route of candidateLists) {
    const vec = qv ? vectorCandidates(qv, route.ctx) : noVectors()
    for (const [keys, w] of [
      [route.kw, 1],
      [route.short, 1],
      [route.exact, 1.5],
      [vec.keys, 1.2]
    ] as [Key[], number][])
      keys.forEach((key, i) => scores.set(key, (scores.get(key) ?? 0) + (route.boost * w) / (RRF_K + i)))
    for (const key of [...route.kw, ...route.short, ...route.exact]) kwSet.add(key)
    for (const key of vec.keys) vecSet.add(key)
    for (const [key, d] of vec.dist) dist.set(key, Math.min(dist.get(key) ?? Infinity, d))
  }
  const effective: ChatScope =
    base.sourceIds !== null && base.noteIds !== null
      ? {
          type: 'items',
          sources: [...new Set([...base.sourceIds, ...priorityIds.sources])],
          notes: [...new Set([...base.noteIds, ...priorityIds.notes])]
        }
      : scope
  const hydrated = hydrate([...scores.keys()], effective, allow)
  const ranked = [...hydrated]
    .map(([key, hit]) => ({
      key,
      hit: {
        ...hit,
        ...(priority.has(hit.parentType + ':' + hit.parentId) ? { projectSource: true } : {}),
        via: (kwSet.has(key) && vecSet.has(key) ? 'both' : vecSet.has(key) ? 'semantic' : 'keyword') as SearchHit['via'],
        score: (scores.get(key) ?? 0) * weight(hit) * (prefer && hit.parentId === prefer ? 1.6 : 1),
        ...(dist.has(key) ? { sim: clampSim(1 - dist.get(key)!) } : {})
      }
    }))
    .sort(
      (a, b) => Number(!!b.hit.projectSource) - Number(!!a.hit.projectSource) || b.hit.score - a.hit.score || a.key.localeCompare(b.key)
    )
  const selected: typeof ranked = [],
    sets: Set<string>[] = [],
    counts = new Map<string, number>()
  for (const candidate of ranked) {
    const grams = trigrams(candidate.hit.text),
      duplicate = sets.findIndex((s) => jaccard(s, grams) >= RETRIEVAL.DUP_JACCARD)
    if (duplicate >= 0) {
      const kept = selected[duplicate].hit
      if (kept.title !== candidate.hit.title) kept.alsoIn = [...new Set([...(kept.alsoIn ?? []), candidate.hit.title])].slice(0, 3)
      continue
    }
    const parent = candidate.hit.parentType + ':' + candidate.hit.parentId
    if (
      !base.restricted &&
      (counts.get(parent) ?? 0) >= (routedIds.has(candidate.hit.parentId) ? RETRIEVAL.ROUTED_PER_PARENT : RETRIEVAL.PER_PARENT)
    )
      continue
    if (selected.length >= limit) continue
    selected.push(candidate)
    sets.push(grams)
    counts.set(parent, (counts.get(parent) ?? 0) + 1)
  }
  // 展开只读前后文；在SQL中再次核对隐私/附件范围，引用身份始终保留首段。
  for (const { hit, key } of selected)
    if (key.startsWith('segment:') && hit.text.length < 120) {
      const grant = allow?.sourceIds ?? []
      const row = getSqlite()
        .prepare(
          `SELECT n.*,s.space FROM source_segments g JOIN source_segments n ON n.source_id=g.source_id AND n.ordinal=g.ordinal+1 JOIN sources s ON s.id=g.source_id WHERE g.id=? AND n.heading=g.heading AND s.deleted_at IS NULL AND ((s.space='library' AND s.ai_excluded=0) OR (s.space='attachment' AND s.id IN (${grant.length ? grant.map(() => '?').join(',') : 'NULL'})))`
        )
        .get(hit.ownerId, ...grant) as (typeof sourceSegments.$inferSelect & { space: string }) | undefined
      if (row) {
        const neighbor =
          row.space === 'attachment' || grant.includes(hit.parentId)
            ? tablePreview(listSegments(hit.parentId)).find((g) => g.id === row.id)?.text
            : row.text
        if (neighbor && hit.text.length + neighbor.length + 3 <= 600) hit.text += '\n…\n' + neighbor
      }
    }
  const missing = selected.filter(({ hit }) => hit.sim === undefined)
  if (qv && missing.length)
    try {
      const guard = () => {
        const current = hydrate(
          missing.map((r) => r.key),
          effective,
          allow
        )
        if (missing.some((r) => !current.has(r.key))) throw new Error('Retrieval permission changed')
      }
      const vectors = await embed(
        missing.map(({ hit }) => embeddingText(hit.heading ? hit.heading + '\n' + hit.text : hit.text)),
        'doc',
        missing.map(({ hit }) => hit.title),
        guard
      )
      missing.forEach(({ hit }, i) => {
        const v = vectors[i]
        if (v?.length === qv!.length && v.every(Number.isFinite)) hit.sim = clampSim(qv!.reduce((sum, n, j) => sum + n * v[j], 0))
      })
    } catch {
      /* 相似度为附加元数据；不能为补算而绕过即时隐私检查。 */
    }
  const current = hydrate(
    selected.map((r) => r.key),
    effective,
    allow
  )
  return selected.filter((r) => current.has(r.key)).map((r) => r.hit)
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
