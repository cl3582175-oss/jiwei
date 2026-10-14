import { getSqlite, getDb } from '../db'
import { eq } from 'drizzle-orm'
import { conversationAttachments as refs, sources } from '../db/schema'
import { emit } from '../events'
import { addAttachmentOrigins, attachmentOrigins } from '../lib/attachmentOrigins'
import { readNoteState } from './noteState'

/** 直接生成与后台整理不一定有提案；在读取内容前就持久记录来源并关闭 AI。 */
export function protectNoteAttachments(noteId: string, sourceIds: string[]): void {
  const sql = getSqlite()
  sql.transaction(() => {
    const update = addAttachmentOrigins(readNoteState(noteId), sourceIds)
    if (update)
      sql.prepare('INSERT INTO note_updates(note_id,[update],created_at) VALUES(?,?,?)').run(noteId, Buffer.from(update), Date.now())
    if (noteHasPrivateAttachments(noteId)) sql.prepare('UPDATE notes SET ai_excluded=1 WHERE id=?').run(noteId)
    if (update) emit('docs:updated', { noteId, update })
  })()
  emit('notes:changed', { ids: [noteId] })
}

/** 没有新建派生内容表：沿用提案的来源元数据，防止保存回答后反向泄露附件。 */
export function conversationAttachmentIds(conversationId: string): string[] {
  return getDb()
    .select({ id: refs.sourceId })
    .from(refs)
    .where(eq(refs.conversationId, conversationId))
    .all()
    .map((r) => r.id)
}

export function protectProposalAttachments(proposalId: string, sourceIds: string[]): void {
  const db = getDb()
  sourceIds = sourceIds.filter((id) => {
    const s = db.select().from(sources).where(eq(sources.id, id)).get()
    return !s || s.space === 'attachment' || !!db.select().from(refs).where(eq(refs.sourceId, id)).get()
  })
  if (!sourceIds.length) return
  const sql = getSqlite(),
    row = sql.prepare('SELECT note_id,ops FROM proposals WHERE id=?').get(proposalId) as { note_id: string; ops: string } | undefined
  if (!row) return
  const payload = JSON.parse(row.ops),
    ids = [...new Set([...(payload.attachmentSourceIds ?? []), ...sourceIds])]
  sql.prepare('UPDATE proposals SET ops=? WHERE id=?').run(JSON.stringify({ ...payload, attachmentSourceIds: ids }), proposalId)
  if (noteHasPrivateAttachments(row.note_id)) {
    sql.prepare('UPDATE notes SET ai_excluded=1 WHERE id=?').run(row.note_id)
    emit('notes:changed', { ids: [row.note_id] })
  }
}

/** 删除不等于公开；只有所有来源都归档才允许用户重新开启笔记的 AI 权限。 */
export function noteHasPrivateAttachments(noteId: string): boolean {
  const db = getDb()
  if (
    attachmentOrigins(readNoteState(noteId)).some((id) => {
      const source = db.select({ space: sources.space }).from(sources).where(eq(sources.id, id)).get()
      return !source || source.space === 'attachment'
    })
  )
    return true
  return !!getSqlite()
    .prepare(
      `SELECT 1 FROM proposals p JOIN json_each(CASE WHEN json_valid(p.ops) THEN json_extract(p.ops,'$.attachmentSourceIds') END) j LEFT JOIN sources s ON s.id=j.value WHERE p.note_id=? AND (s.id IS NULL OR s.space='attachment') LIMIT 1`
    )
    .get(noteId)
}
