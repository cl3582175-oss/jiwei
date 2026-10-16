import { getSqlite, getDb } from '../db'
import { eq } from 'drizzle-orm'
import { conversationAttachments as refs, sources } from '../db/schema'
import { emit } from '../events'
import { addAttachmentOrigins } from '../lib/attachmentOrigins'
import { readNoteState } from './noteState'
import { privateAttachmentsOf, refreshNotePrivacy } from './notePrivacy'

/** 直接生成与后台整理不一定有提案；在读取内容前就持久记录来源并关闭 AI。 */
export function protectNoteAttachments(noteId: string, sourceIds: string[]): void {
  const sql = getSqlite()
  sql.transaction(() => {
    const update = addAttachmentOrigins(readNoteState(noteId), sourceIds)
    if (update)
      sql.prepare('INSERT INTO note_updates(note_id,[update],created_at) VALUES(?,?,?)').run(noteId, Buffer.from(update), Date.now())
    refreshNotePrivacy([noteId])
    if (update) emit('docs:updated', { noteId, update })
  })()
  emit('notes:changed', { ids: [noteId] })
}

/** 没有新建派生内容表：沿用提案的来源元数据，防止保存回答后反向泄露附件。 */
export function conversationAttachmentIds(conversationId: string): string[] {
  // Inherit provenance for saved answers without granting source-read access to the child.
  return (
    getSqlite()
      .prepare(
        `WITH RECURSIVE family(id) AS (
    SELECT ? UNION SELECT m.conversation_id FROM family f JOIN conversations c ON c.id=f.id
    JOIN messages m ON m.id=c.anchor_parent_id
    WHERE json_valid(c.anchor) AND json_extract(c.anchor,'$.parentType')='message'
  ), provenance(id) AS (
    SELECT ca.source_id FROM conversation_attachments ca JOIN family f ON ca.conversation_id=f.id
    UNION SELECT ps.item_id FROM family f JOIN conversations c ON c.id=f.id
      JOIN project_sources ps ON ps.project_id=c.project_id WHERE ps.item_type='source' AND ps.origin<>'library'
    UNION SELECT j.value FROM family f JOIN messages m ON m.conversation_id=f.id
      JOIN json_each(CASE WHEN json_valid(m.context) THEN json_extract(m.context,'$.projectPrivateSourceIds') END) j
  ) SELECT DISTINCT id FROM provenance`
      )
      .all(conversationId) as { id: string }[]
  ).map((r) => r.id)
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
  refreshNotePrivacy([row.note_id])
}

/** 删除不等于公开；只有所有来源都归档才允许用户重新开启笔记的 AI 权限。 */
export function noteHasPrivateAttachments(noteId: string): boolean {
  return privateAttachmentsOf(noteId).length > 0
}
