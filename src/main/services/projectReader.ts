import { and, eq } from 'drizzle-orm'
import { ProjectReaderSourceSchema, type ProjectReaderSource } from '@shared/context'
import { getDb, getSqlite } from '../db'
import { conversations, conversationAttachments } from '../db/schema'
import { emit } from '../events'
import { tr } from '../lib/messages'

const metadata = (raw: string | null): Record<string, unknown> => {
  const value: unknown = raw ? JSON.parse(raw) : {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid conversation metadata')
  return value as Record<string, unknown>
}

function liveReaderSource(reader: ProjectReaderSource): boolean {
  return !!getSqlite()
    .prepare(
      `SELECT 1 FROM project_sources ps
    JOIN chat_projects p ON p.id=ps.project_id AND p.deleted_at IS NULL
    JOIN sources s ON s.id=ps.item_id AND s.deleted_at IS NULL
    WHERE ps.project_id=? AND ps.item_type='source' AND ps.item_id=? AND
      ((s.space='attachment' AND ps.origin<>'library') OR (s.space='library' AND s.ai_excluded=0))`
    )
    .get(reader.projectId, reader.sourceId)
}

/** Local reader metadata only; this does not grant an AI conversation access. */
export function sourceReaderProject(sourceId: string): string | null {
  const rows = getSqlite()
    .prepare(
      `SELECT ps.project_id AS id FROM project_sources ps
    JOIN chat_projects p ON p.id=ps.project_id AND p.deleted_at IS NULL
    JOIN sources s ON s.id=ps.item_id AND s.deleted_at IS NULL AND s.space='attachment'
    WHERE ps.item_type='source' AND ps.item_id=? AND ps.origin<>'library' LIMIT 2`
    )
    .all(sourceId) as { id: string }[]
  return rows.length === 1 ? rows[0].id : null
}

/** Additional restriction on existing attachment rows: reader provenance never becomes a permanent grant. */
export function readerSourceAccessible(sourceId: string, conversationId: string): boolean {
  const row = getDb().select({ meta: conversations.meta }).from(conversations).where(eq(conversations.id, conversationId)).get()
  // Decision attachments retain their existing owner check in canReadSource.
  if (!row) return true
  try {
    const meta = metadata(row.meta)
    if (meta.readerSource === undefined) return true
    const parsed = ProjectReaderSourceSchema.safeParse(meta.readerSource)
    if (!parsed.success) return false
    return parsed.data.sourceId !== sourceId || liveReaderSource(parsed.data)
  } catch {
    return false
  }
}

export function releaseProjectReaderSource(conversationId: string): void {
  const db = getDb()
  const row = db.select({ meta: conversations.meta }).from(conversations).where(eq(conversations.id, conversationId)).get()
  if (!row) return
  let reader: ProjectReaderSource | undefined
  try {
    const parsed = ProjectReaderSourceSchema.safeParse(metadata(row.meta).readerSource)
    reader = parsed.success ? parsed.data : undefined
  } catch {
    return
  }
  if (!reader) return
  db.update(conversationAttachments)
    .set({ removedAt: Date.now() })
    .where(and(eq(conversationAttachments.conversationId, conversationId), eq(conversationAttachments.sourceId, reader.sourceId)))
    .run()
  emit('attachments:changed', { sourceIds: [reader.sourceId], conversationId })
}

/** A reader grant describes the current app session, not a permission restored on restart/vault switch. */
export function resetProjectReaderSources(): void {
  getSqlite()
    .prepare(
      `UPDATE conversation_attachments SET removed_at=? WHERE EXISTS (
    SELECT 1 FROM conversations c WHERE c.id=conversation_attachments.conversation_id
    AND json_extract(CASE WHEN json_valid(c.meta) THEN c.meta ELSE '{}' END,'$.readerSource.sourceId')=conversation_attachments.source_id
  )`
    )
    .run(Date.now())
}

/** Called inside chat.send's transaction before any source/context or model request is prepared. */
export function bindProjectReaderSource(conversationId: string, requested?: ProjectReaderSource): void {
  if (!requested) return releaseProjectReaderSource(conversationId)
  const reader = ProjectReaderSourceSchema.parse(requested)
  const db = getDb()
  const conversation = db.select().from(conversations).where(eq(conversations.id, conversationId)).get()
  if (!conversation || conversation.deletedAt !== null || conversation.kind !== 'workspace' || conversation.projectId !== null)
    throw new Error(tr('当前会话不支持项目文件阅读', 'This conversation does not support project-file reading'))
  const meta = metadata(conversation.meta)
  const previous = meta.readerSource === undefined ? null : ProjectReaderSourceSchema.parse(meta.readerSource)
  if (previous && (previous.projectId !== reader.projectId || previous.sourceId !== reader.sourceId))
    throw new Error(tr('请在该文件自己的阅读对话中提问', 'Use this file’s own reader conversation'))
  if (!liveReaderSource(reader))
    throw new Error(tr('项目来源已移除或不可用，无法继续读取', 'The project source was removed or is unavailable'))
  db.update(conversations)
    .set({ meta: JSON.stringify({ ...meta, readerSource: reader, suppressAttachmentMemory: true }) })
    .where(eq(conversations.id, conversationId))
    .run()
  db.insert(conversationAttachments)
    .values({ conversationId, sourceId: reader.sourceId, createdAt: Date.now() })
    .onConflictDoUpdate({ target: [conversationAttachments.conversationId, conversationAttachments.sourceId], set: { removedAt: null } })
    .run()
  emit('attachments:changed', { sourceIds: [reader.sourceId], conversationId })
}
