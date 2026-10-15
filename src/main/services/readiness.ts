import { eq, inArray } from 'drizzle-orm'
import { FORMATS } from '@shared/formats'
import { ReadinessItemSchema, type Readiness, type ReadinessItem } from '@shared/readiness'
export type { Readiness } from '@shared/readiness'
import { getDb, getSqlite } from '../db'
import { sources, assets } from '../db/schema'
import { canReadSource } from './attachmentsAccess'
import { sourceRecognition } from './recognize'
import { canAutoTranscribe } from './asr'
import { getStatus } from './ai/embedding'
import { sourceIndexCounts } from './ai/sourceIndexStatus'
import { enqueueSegment } from './segmentJobs'
import { getSettings } from './settings'

type SourceRow = typeof sources.$inferSelect & { ext: string | null }
function calculate(row: SourceRow): Readiness {
  const sql = getSqlite()
  const jobs = sql
    .prepare(
      "SELECT status FROM jobs WHERE kind='source.segment' AND (dedupe_key=? OR json_extract(payload,'$.sourceId')=?) ORDER BY updated_at DESC,created_at DESC"
    )
    .all(`segment:${row.id}`, row.id) as { status: string }[]
  if (jobs.some((j) => j.status === 'queued' || j.status === 'running')) return { state: 'preparing', reason: 'parsing' }
  const media = ['audio', 'video', 'recording'].includes(row.kind)
  const format = row.ext ? FORMATS[row.ext] : null
  if (row.ext && !format?.parser && row.kind !== 'image' && !media)
    return {
      state: 'unreadable',
      reason: 'unsupported',
      action: null,
      ...(format?.note ? { note: format.note[getSettings().language.startsWith('zh') ? 'zh' : 'en'] } : {})
    }
  if (media && !sql.prepare("SELECT 1 FROM source_segments WHERE source_id=? AND kind='transcript' AND trim(text)<>'' LIMIT 1").get(row.id))
    return { state: 'unreadable', reason: 'needs-transcript', action: canAutoTranscribe() ? 'transcribe' : null }
  if (jobs[0]?.status === 'failed' || row.parseVersion < 0) return { state: 'unreadable', reason: 'failed', action: null }
  const pages = sql.prepare("SELECT status FROM source_pages WHERE source_id=? AND need='scan'").all(row.id) as { status: string }[]
  const pending = pages.filter((p) => p.status === 'pending' || p.status === 'failed').length
  const counts = sourceIndexCounts(row.id)
  if (pending) {
    const engine = sourceRecognition(row.id).engine
    const action = engine === 'ready' ? 'recognize' : engine === 'needs-install' ? 'install-recognizer' : null
    return counts.segments
      ? { state: 'partial', reason: 'scan-pending', pending, total: pages.length, action }
      : { state: 'unreadable', reason: 'scan-pending', pending, total: pages.length, action }
  }
  if (!counts.segments) return { state: 'unreadable', reason: 'empty', action: null }
  if (getStatus().state === 'ready' && counts.embedded < counts.indexable)
    return { state: 'preparing', reason: 'indexing', progress: counts.embedded / counts.indexable }
  return { state: 'ready' }
}
/** 默认只返回允许AI读取的资料库；附件必须有仍有效的所属对话关系，不能接受调用者自造的allow。 */
export function readinessMany(ids: string[], conversationId: string | null = null): Record<string, Readiness> {
  const out: Record<string, Readiness> = {}
  for (let at = 0; at < ids.length; at += 500) {
    const rows = getDb()
      .select({ s: sources, ext: assets.ext })
      .from(sources)
      .leftJoin(assets, eq(assets.id, sources.assetId))
      .where(inArray(sources.id, ids.slice(at, at + 500)))
      .all()
    for (const { s, ext } of rows) if (canReadSource(s.id, conversationId)) out[s.id] = calculate({ ...s, ext })
  }
  return out
}
export function sourceReadiness(sourceId: string, conversationId: string | null = null): Readiness {
  return readinessMany([sourceId], conversationId)[sourceId] ?? { state: 'unreadable', reason: 'empty', action: null }
}
export function retrySource(sourceId: string, conversationId: string | null = null): void {
  if (!canReadSource(sourceId, conversationId)) throw new Error('Source is outside the allowed scope')
  enqueueSegment(sourceId)
}
/** 后端上下文使用与界面相同的状态含义；不包含格式或模型的内部错误细节。 */
export function readinessDescription(r: Readiness, zh: boolean): string {
  if (r.state === 'ready') return zh ? '已就绪' : 'Ready'
  if (r.state === 'preparing')
    return r.reason === 'parsing'
      ? zh
        ? '正在读取内容'
        : 'Reading content'
      : zh
        ? `正在建立检索索引 ${Math.floor((r.progress ?? 0) * 100)}%`
        : `Building search index ${Math.floor((r.progress ?? 0) * 100)}%`
  if (r.state === 'partial')
    return zh
      ? `还有 ${r.pending}/${r.total} 页扫描页没有识别，这些页搜不到`
      : `${r.pending} of ${r.total} scanned pages not recognized yet; they can't be searched`
  const messages = {
    'scan-pending': ['这是扫描件，还没有识别，内容暂时搜不到', "Scanned document not recognized yet; its content can't be searched"],
    unsupported: ['暂时读不了这种格式的内容', "This format can't be read yet"],
    'needs-transcript': ['还没有转写，说的内容暂时搜不到', "Not transcribed yet; speech can't be searched"],
    empty: ['没有读到文字内容', 'No text found'],
    failed: ['读取失败，可以重新读取', "Couldn't read this file; try again"]
  }
  return messages[r.reason][zh ? 0 : 1]
}

export function readinessForSources(ids: string[], conversationId: string | null = null): ReadinessItem[] {
  const states = readinessMany(ids, conversationId),
    selected = [...new Set(ids)].filter((id) => states[id] && states[id].state !== 'ready').slice(0, 5)
  const rows = selected.length
    ? getDb().select({ id: sources.id, title: sources.title }).from(sources).where(inArray(sources.id, selected)).all()
    : []
  return selected.flatMap((sourceId) => {
    const source = rows.find((r) => r.id === sourceId)
    return source ? [{ sourceId, title: source.title, readiness: states[sourceId] }] : []
  })
}
export function storedReadiness(raw: string | null, conversationId: string): ReadinessItem[] {
  try {
    const parsed = ReadinessItemSchema.array()
      .max(5)
      .safeParse(raw ? (JSON.parse(raw) as { readiness?: unknown }).readiness : [])
    return parsed.success ? parsed.data.filter((item) => canReadSource(item.sourceId, conversationId)) : []
  } catch {
    return []
  }
}
