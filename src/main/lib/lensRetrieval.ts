import type { RecordingFilters } from '@shared/lens'
// 别名由检索层固定，所有外部筛选值仍走绑定参数，不插入 SQL 字符串。
export function lensFilterSQL(filters: RecordingFilters): { sql: string; params: string[] } {
  const predicates = ['s.deleted_at IS NULL', 's.ai_excluded = 0', '(r.id IS NULL OR r.deleted_at IS NULL)'],
    params: string[] = []
  if (filters.personId) {
    predicates.push("json_extract(g.locator, '$.personId') = ?")
    params.push(filters.personId)
  }
  if (filters.scene) {
    predicates.push("COALESCE(r.scene, 'unspecified') = ?")
    params.push(filters.scene)
  }
  if (filters.seriesId) {
    predicates.push('r.series_id = ?')
    params.push(filters.seriesId)
  }
  if (filters.from) {
    predicates.push("date(COALESCE(r.started_at, s.accessed_at) / 1000, 'unixepoch', 'localtime') >= ?")
    params.push(filters.from)
  }
  if (filters.to) {
    predicates.push("date(COALESCE(r.started_at, s.accessed_at) / 1000, 'unixepoch', 'localtime') <= ?")
    params.push(filters.to)
  }
  return { sql: predicates.join(' AND '), params }
}
export function lensKeywordSQL(filters: RecordingFilters): { sql: string; params: string[] } {
  const filter = lensFilterSQL(filters)
  return {
    sql: `SELECT segment_id FROM segments_fts JOIN source_segments g ON g.id=segments_fts.segment_id JOIN sources s ON s.id=g.source_id LEFT JOIN recordings r ON r.source_id=s.id WHERE segments_fts MATCH ? AND g.kind='transcript' AND ${filter.sql} ORDER BY rank LIMIT ?`,
    params: filter.params
  }
}
export function lensVectorSQL(filters: RecordingFilters): { sql: string; params: string[] } {
  const filter = lensFilterSQL(filters)
  return {
    sql: `SELECT v.rowid, vec_distance_cosine(v.embedding, ?) AS distance FROM vec_chunks v JOIN chunks c ON c.rowid=v.rowid AND c.owner_type='segment' JOIN source_segments g ON g.id=c.owner_id JOIN sources s ON s.id=g.source_id LEFT JOIN recordings r ON r.source_id=s.id WHERE g.kind='transcript' AND ${filter.sql} ORDER BY distance LIMIT ?`,
    params: filter.params
  }
}
