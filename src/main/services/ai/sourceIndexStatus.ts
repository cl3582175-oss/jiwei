import { getSqlite } from '../../db'
import { currentModelId, isReady } from './embedding'

/** 只有仍属于当前正文且实际存在当前模型向量的段才计入，批注/残留chunks不能使进度虚满。 */
export function sourceIndexCounts(sourceId: string): { segments: number; embedded: number } {
  const sql = getSqlite()
  const segments = (
    sql.prepare("SELECT count(*) n FROM source_segments WHERE source_id=? AND trim(text)<>''").get(sourceId) as { n: number }
  ).n
  const embedded = (
    sql
      .prepare(
        "SELECT count(DISTINCT g.id) n FROM source_segments g JOIN chunks c ON c.owner_type='segment' AND c.owner_id=g.id AND c.parent_type='source' AND c.parent_id=g.source_id JOIN vec_chunks v ON v.rowid=c.rowid WHERE g.source_id=? AND trim(g.text)<>'' AND c.model=?"
      )
      .get(sourceId, currentModelId()) as { n: number }
  ).n
  return { segments, embedded }
}
export async function sourceIndexStatus(sourceId: string): Promise<{ segments: number; embedded: number; semantic: boolean }> {
  return { ...sourceIndexCounts(sourceId), semantic: await isReady().catch(() => false) }
}
