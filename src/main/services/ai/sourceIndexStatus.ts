import { getSqlite } from '../../db'
import { currentModelId, isReady } from './embedding'
import { getSettings } from '../settings'
import { isIndexableText } from '../../lib/indexableText'
import { canReadSource } from '../attachmentsAccess'

/** 可读正文与可索引正文分开计数；仅当前正文的当前模型真实向量算完成。 */
export function sourceIndexCounts(sourceId: string): { segments: number; indexable: number; embedded: number } {
  const sql = getSqlite()
  const rows = sql.prepare('SELECT id,text FROM source_segments WHERE source_id=?').all(sourceId) as { id: string; text: string }[]
  const source = sql.prepare('SELECT space FROM sources WHERE id=?').get(sourceId) as { space: string } | undefined
  const eligible = new Set(
    (source?.space === 'attachment' && getSettings().ai.embedding?.mode === 'cloud' ? [] : rows.filter((r) => isIndexableText(r.text))).map(
      (r) => r.id
    )
  )
  const vectors = sql
    .prepare(
      "SELECT DISTINCT g.id FROM source_segments g JOIN chunks c ON c.owner_type='segment' AND c.owner_id=g.id AND c.parent_type='source' AND c.parent_id=g.source_id JOIN vec_chunks v ON v.rowid=c.rowid WHERE g.source_id=? AND c.model=?"
    )
    .all(sourceId, currentModelId()) as { id: string }[]
  return {
    segments: rows.filter((r) => r.text.trim()).length,
    indexable: eligible.size,
    embedded: vectors.filter((r) => eligible.has(r.id)).length
  }
}
export async function sourceIndexStatus(
  sourceId: string,
  conversationId: string | null = null
): Promise<{ segments: number; indexable: number; embedded: number; semantic: boolean }> {
  if (!canReadSource(sourceId, conversationId)) return { segments: 0, indexable: 0, embedded: 0, semantic: false }
  const counts = sourceIndexCounts(sourceId)
  return { ...counts, semantic: counts.indexable > 0 && (await isReady().catch(() => false)) }
}
