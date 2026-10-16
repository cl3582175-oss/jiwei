import type { ChatScope } from '@shared/schemas'
import type { RecordingFilters } from '@shared/lens'
import log from 'electron-log/main'
import { getSqlite } from '../../db'
import { exactTerms, ftsQuery, shortTerms } from '../../lib/fts'
import { normalizeQuery } from '../../lib/textNormalize'
import { lensFilterSQL } from '../../lib/lensRetrieval'
import { currentModelId } from './embedding'
import { vecBuffer } from './indexer'

export const RETRIEVAL = {
  KW_CANDIDATES: 40,
  VEC_CANDIDATES: 40,
  SHORT_CANDIDATES: 40,
  EXACT_CANDIDATES: 20,
  PER_PARENT: 3,
  ROUTED_PER_PARENT: 6,
  DUP_JACCARD: 0.9
} as const
export interface RetrievalOptions {
  /** 项目补充材料独立于普通 scope，在候选截断前单独检索。 */
  priorityIds?: { notes: string[]; sources: string[] }
  sourceIds?: string[]
  notesOnly?: boolean
  includeNotes?: boolean
}
export type CandidateKey = string
type Binding = string | number | Buffer
type Clause = { sql: string; params: Binding[] }
export interface CandidateScope {
  excludeSources?: string[]
  excludeNotes?: string[]
  sourceIds: string[] | null
  noteIds: string[] | null
  allowIds: string[]
  filters: RecordingFilters
  restricted: boolean
}
export interface VectorHits {
  keys: CandidateKey[]
  dist: Map<CandidateKey, number>
  qv: number[] | null
}
export const noVectors = (): VectorHits => ({ keys: [], dist: new Map(), qv: null })
const filtered = (ctx: CandidateScope): boolean => Object.values(ctx.filters).some(Boolean)
const groups = (ids: string[] | null): (string[] | null)[] =>
  ids === null
    ? [null]
    : ids.length
      ? Array.from({ length: Math.ceil(ids.length / 500) }, (_, i) => ids.slice(i * 500, i * 500 + 500))
      : [[]]
const inIds = (column: string, ids: string[] | null): Clause =>
  ids === null
    ? { sql: '1', params: [] }
    : ids.length
      ? { sql: `${column} IN (${ids.map(() => '?').join(',')})`, params: ids }
      : { sql: '0', params: [] }
export function candidateScope(
  scope: ChatScope,
  filters: RecordingFilters,
  allow?: { sourceIds: string[] },
  opts: RetrievalOptions = {}
): CandidateScope {
  let sourceIds = scope.type === 'items' ? [...new Set(scope.sources)] : scope.type === 'none' ? [] : null
  let noteIds = scope.type === 'items' ? [...new Set(scope.notes)] : scope.type === 'none' ? [] : null
  if (opts.sourceIds?.length) {
    sourceIds = [...new Set(opts.sourceIds)].filter((id) => sourceIds === null || sourceIds.includes(id))
    if (!opts.includeNotes) noteIds = []
  }
  if (opts.notesOnly) sourceIds = []
  if (Object.values(filters).some(Boolean)) noteIds = []
  return {
    sourceIds,
    noteIds,
    allowIds: [...new Set(allow?.sourceIds ?? [])],
    filters,
    restricted: scope.type === 'items' || !!opts.sourceIds?.length || !!opts.notesOnly
  }
}
export function routedScope(ctx: CandidateScope, ids: string[]): CandidateScope {
  return { ...ctx, sourceIds: ids, noteIds: [], restricted: true }
}
function sourceClause(ctx: CandidateScope, ids: string[] | null = ctx.sourceIds, allow = ctx.allowIds): Clause {
  const grant = inIds('s.id', allow),
    scope = inIds('s.id', ids)
  const clauses = [
    `s.deleted_at IS NULL AND ((s.space='library' AND s.ai_excluded=0) OR (s.space='attachment' AND ${grant.sql}))`,
    scope.sql
  ]
  const params: Binding[] = [...grant.params, ...scope.params]
  if (ctx.excludeSources?.length) {
    clauses.push(`s.id NOT IN (${ctx.excludeSources.map(() => '?').join(',')})`)
    params.push(...ctx.excludeSources)
  }
  if (filtered(ctx)) {
    const f = lensFilterSQL(ctx.filters)
    clauses.push("g.kind='transcript'", f.sql)
    params.push(...f.params)
  }
  return { sql: clauses.join(' AND '), params }
}
function noteClause(ids: string[] | null, excluded: string[] = []): Clause {
  const scope = inIds('n.id', ids)
  return {
    sql: `n.deleted_at IS NULL AND n.ai_excluded=0 AND ${scope.sql}${excluded.length ? ` AND n.id NOT IN (${excluded.map(() => '?').join(',')})` : ''}`,
    params: [...scope.params, ...excluded]
  }
}
const sourceJoin =
  'JOIN source_segments g ON g.id=segments_fts.segment_id JOIN sources s ON s.id=g.source_id LEFT JOIN recordings r ON r.source_id=s.id'
const sourceScanJoin = 'source_segments g JOIN sources s ON s.id=g.source_id LEFT JOIN recordings r ON r.source_id=s.id'
const owner = "CASE WHEN b.section IN ('row','summary') THEN b.id ELSE COALESCE(b.row_id,b.id) END"
const blockJoin = `JOIN blocks b ON b.id=blocks_fts.block_id JOIN blocks o ON o.id=${owner} AND o.deleted_at IS NULL JOIN notes n ON n.id=o.note_id`
const blockScanJoin = `blocks b JOIN blocks o ON o.id=${owner} AND o.deleted_at IS NULL JOIN notes n ON n.id=o.note_id`
const unique = (keys: string[], limit: number): string[] => [...new Set(keys)].slice(0, limit)
const interleave = (a: string[], b: string[], limit: number): string[] =>
  unique(
    Array.from({ length: Math.max(a.length, b.length) }, (_, i) => [a[i], b[i]])
      .flat()
      .filter(Boolean),
    limit
  )

function phrases(ctx: CandidateScope, query: string, limit: number): { notes: string[]; sources: string[] } {
  const sql = getSqlite(),
    n: { id: string; rank: number }[] = [],
    s: { id: string; rank: number }[] = []
  for (const ids of groups(ctx.noteIds)) {
    const c = noteClause(ids, ctx.excludeNotes)
    n.push(
      ...(sql
        .prepare(
          `SELECT o.id,MIN(blocks_fts.rank) rank FROM blocks_fts ${blockJoin} WHERE blocks_fts MATCH ? AND b.deleted_at IS NULL AND ${c.sql} GROUP BY o.id ORDER BY rank LIMIT ?`
        )
        .all(query, ...c.params, limit) as { id: string; rank: number }[])
    )
  }
  for (const ids of groups(ctx.sourceIds)) {
    const c = sourceClause(ctx, ids)
    s.push(
      ...(sql
        .prepare(
          `SELECT g.id,segments_fts.rank rank FROM segments_fts ${sourceJoin} WHERE segments_fts MATCH ? AND ${c.sql} ORDER BY rank LIMIT ?`
        )
        .all(query, ...c.params, limit) as { id: string; rank: number }[])
    )
  }
  const ranked = (rows: { id: string; rank: number }[], kind: string) =>
    rows.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id)).map((r) => kind + ':' + r.id)
  return { notes: ranked(n, 'block'), sources: ranked(s, 'segment') }
}
export function keywordCandidates(query: string, ctx: CandidateScope): CandidateKey[] {
  const fq = ftsQuery(query),
    main = fq ? phrases(ctx, fq, RETRIEVAL.KW_CANDIDATES) : { notes: [], sources: [] }
  const extras: string[] = [],
    sql = getSqlite(),
    q = normalizeQuery(query)
  if (!filtered(ctx) && q.length >= 2 && q.length <= 60) {
    const pattern = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'
    const n = noteClause(ctx.noteIds, ctx.excludeNotes),
      s = sourceClause(ctx, ctx.sourceIds, [])
    for (const r of sql
      .prepare(
        `SELECT a.id FROM annotations a LEFT JOIN notes n ON a.target_type='note' AND n.id=a.target_id LEFT JOIN sources s ON a.target_type='source' AND s.id=a.target_id WHERE a.deleted_at IS NULL AND a.body IS NOT NULL AND ((a.target_type='note' AND ${n.sql}) OR (a.target_type='source' AND ${s.sql})) AND (a.body LIKE ? ESCAPE '\\' OR a.selector LIKE ? ESCAPE '\\') LIMIT ?`
      )
      .all(...n.params, ...s.params, pattern, pattern, RETRIEVAL.KW_CANDIDATES) as { id: string }[])
      extras.push('annotation:' + r.id)
    for (const r of sql
      .prepare(
        `SELECT r.id FROM note_asset_blocks r JOIN asset_texts t ON t.asset_id=r.asset_id JOIN notes n ON n.id=r.note_id WHERE ${n.sql} AND t.text LIKE ? ESCAPE '\\' LIMIT ?`
      )
      .all(...n.params, pattern, RETRIEVAL.KW_CANDIDATES) as { id: string }[])
      extras.push('asset:' + r.id)
  }
  return interleave(interleave(main.notes, main.sources, RETRIEVAL.KW_CANDIDATES), extras, RETRIEVAL.KW_CANDIDATES)
}
type TextCandidate = { id: string; text: string; heading?: string; key: string }
function scanCandidates(ctx: CandidateScope, predicate: string, values: string[], limit: number): TextCandidate[] {
  const sql = getSqlite(),
    out: TextCandidate[] = []
  for (const ids of groups(ctx.sourceIds)) {
    const c = sourceClause(ctx, ids)
    const rows = sql
      .prepare(`SELECT g.id,g.text,g.heading FROM ${sourceScanJoin} WHERE ${c.sql} AND (${predicate}) ORDER BY g.ordinal,g.id LIMIT ?`)
      .all(...c.params, ...values, limit) as Omit<TextCandidate, 'key'>[]
    out.push(...rows.map((r) => ({ ...r, key: 'segment:' + r.id })))
  }
  // 两边共享同一检索单位；笔记的 cue/body 命中仍归并到真实康奈尔行。
  const notePredicate = predicate.replace(/g\.heading/g, "''").replace(/g\.text/g, 'b.text')
  for (const ids of groups(ctx.noteIds)) {
    const c = noteClause(ids, ctx.excludeNotes)
    const rows = sql
      .prepare(
        `SELECT o.id,o.text FROM ${blockScanJoin} WHERE b.deleted_at IS NULL AND ${c.sql} AND (${notePredicate}) GROUP BY o.id ORDER BY o.position,o.id LIMIT ?`
      )
      .all(...c.params, ...values, limit) as Omit<TextCandidate, 'key'>[]
    out.push(...rows.map((r) => ({ ...r, key: 'block:' + r.id })))
  }
  return [...new Map(out.map((r) => [r.key, r])).values()]
}
export function exactCandidates(query: string, ctx: CandidateScope): CandidateKey[] {
  const keys: string[] = []
  for (const term of exactTerms(query)) {
    if ([...term].length >= 3) {
      const hits = phrases(ctx, '"' + term.replace(/"/g, '""') + '"', RETRIEVAL.EXACT_CANDIDATES)
      keys.push(...interleave(hits.notes, hits.sources, RETRIEVAL.EXACT_CANDIDATES))
    } else keys.push(...scanCandidates(ctx, 'instr(g.text,?)>0', [term], RETRIEVAL.EXACT_CANDIDATES).map((r) => r.key))
  }
  return unique(keys, RETRIEVAL.EXACT_CANDIDATES)
}
export function shortCandidates(query: string, ctx: CandidateScope): CandidateKey[] {
  const terms = shortTerms(query)
  if (!terms.length) return []
  const predicate = terms.map(() => "g.text LIKE ? ESCAPE '\\' OR g.heading LIKE ? ESCAPE '\\'").join(' OR ')
  const rows = scanCandidates(
    ctx,
    predicate,
    terms.flatMap((t) => ['%' + t + '%', '%' + t + '%']),
    200
  )
  const scored = rows.map((r) => {
    const text = normalizeQuery((r.heading ?? '') + '\n' + r.text)
    let hits = 0,
      count = 0
    for (const term of terms) {
      let occurrences = 0
      for (let i = text.indexOf(term); i >= 0; i = text.indexOf(term, i + term.length)) occurrences++
      if (occurrences) hits++
      count += occurrences
    }
    return { key: r.key, hits, count }
  })
  return scored
    .sort((a, b) => b.hits - a.hits || b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, RETRIEVAL.SHORT_CANDIDATES)
    .map((r) => r.key)
}

function validChunks(ctx: CandidateScope): Clause {
  const source = sourceClause(ctx),
    note = noteClause(ctx.noteIds, ctx.excludeNotes)
  return {
    sql: `c.model=? AND ((c.parent_type='source' AND ${source.sql}) OR (c.parent_type='note' AND ${note.sql})) AND ((c.owner_type='segment' AND g.id IS NOT NULL AND g.source_id=c.parent_id) OR (c.owner_type='block' AND b.id IS NOT NULL AND b.deleted_at IS NULL AND b.note_id=c.parent_id) OR (c.owner_type='annotation' AND a.id IS NOT NULL AND a.deleted_at IS NULL AND a.target_type=c.parent_type AND a.target_id=c.parent_id AND trim(COALESCE(a.body,''))<>'') OR (c.owner_type='asset' AND ab.id IS NOT NULL AND ab.note_id=c.parent_id))`,
    params: [currentModelId(), ...source.params, ...note.params]
  }
}
const chunkJoin =
  "chunks c LEFT JOIN source_segments g ON c.owner_type='segment' AND g.id=c.owner_id LEFT JOIN sources s ON c.parent_type='source' AND s.id=c.parent_id LEFT JOIN recordings r ON r.source_id=s.id LEFT JOIN notes n ON c.parent_type='note' AND n.id=c.parent_id LEFT JOIN blocks b ON c.owner_type='block' AND b.id=c.owner_id LEFT JOIN annotations a ON c.owner_type='annotation' AND a.id=c.owner_id LEFT JOIN note_asset_blocks ab ON c.owner_type='asset' AND ab.id=c.owner_id"
export function vectorCandidates(v: number[] | null, ctx: CandidateScope): VectorHits {
  if (!v) return noVectors()
  const sql = getSqlite()
  const scoped = ctx.restricted
    ? [
        ...groups(ctx.sourceIds)
          .filter((ids) => ids === null || ids.length)
          .map((sourceIds) => ({ ...ctx, sourceIds, noteIds: [] })),
        ...groups(ctx.noteIds)
          .filter((ids) => ids === null || ids.length)
          .map((noteIds) => ({ ...ctx, noteIds, sourceIds: [] }))
      ]
    : [ctx]
  // 阈值按范围内的实际片段计数，不能因索引尚未完成误走精确全扫。
  const count = ctx.restricted
    ? scoped.reduce((sum, c) => {
        const source = sourceClause(c),
          note = noteClause(c.noteIds, c.excludeNotes)
        const n = (sql.prepare(`SELECT count(*) n FROM ${sourceScanJoin} WHERE ${source.sql}`).get(...source.params) as { n: number }).n
        const b = (
          sql
            .prepare(`SELECT count(DISTINCT o.id) n FROM ${blockScanJoin} WHERE b.deleted_at IS NULL AND ${note.sql}`)
            .get(...note.params) as { n: number }
        ).n
        return sum + n + b
      }, 0)
    : 0
  const exact = filtered(ctx) || (ctx.restricted && count <= 20000)
  let rows: { owner_type: string; owner_id: string; distance: number }[]
  if (exact) {
    rows = scoped
      .flatMap((c) => {
        const where = validChunks(c)
        return sql
          .prepare(
            `SELECT c.owner_type,c.owner_id,vec_distance_cosine(v.embedding,?) distance FROM vec_chunks v JOIN chunks c ON c.rowid=v.rowid ${chunkJoin.replace(/^chunks c /, '')} WHERE ${where.sql} ORDER BY distance LIMIT ?`
          )
          .all(vecBuffer(v), ...where.params, RETRIEVAL.VEC_CANDIDATES) as typeof rows
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, RETRIEVAL.VEC_CANDIDATES)
  } else {
    const global = validChunks({ ...ctx, sourceIds: null, noteIds: ctx.noteIds?.length === 0 ? [] : null, restricted: false })
    const budget = ctx.restricted ? 400 : RETRIEVAL.VEC_CANDIDATES
    // vec0支持rowid IN预筛：先排除隐私与删除，再计算KNN，不能仅靠JOIN事后丢弃。
    const nearest = sql
      .prepare(
        `SELECT rowid,distance FROM vec_chunks WHERE embedding MATCH ? AND rowid IN (SELECT c.rowid FROM ${chunkJoin} WHERE ${global.sql}) AND k=? ORDER BY distance`
      )
      .all(vecBuffer(v), ...global.params, budget) as { rowid: number; distance: number }[]
    if (ctx.restricted) log.info('[retrieval] scoped vector fallback', count, budget)
    const placeholders = nearest.length ? nearest.map(() => '?').join(',') : 'NULL'
    const metadata = new Map(
      scoped
        .flatMap((c) => {
          const where = validChunks(c)
          return sql
            .prepare(`SELECT c.rowid,c.owner_type,c.owner_id FROM ${chunkJoin} WHERE ${where.sql} AND c.rowid IN (${placeholders})`)
            .all(...where.params, ...nearest.map((r) => Number(r.rowid))) as { rowid: number; owner_type: string; owner_id: string }[]
        })
        .map((r) => [r.rowid, r])
    )
    rows = nearest
      .flatMap((r) => {
        const m = metadata.get(Number(r.rowid))
        return m ? [{ ...m, distance: r.distance }] : []
      })
      .slice(0, RETRIEVAL.VEC_CANDIDATES)
  }
  const keys = rows.map((r) => r.owner_type + ':' + r.owner_id),
    dist = new Map<string, number>()
  rows.forEach((r, i) => dist.set(keys[i], Math.min(dist.get(keys[i]) ?? Infinity, r.distance)))
  return { keys, dist, qv: v }
}
