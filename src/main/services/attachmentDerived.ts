import { getSqlite } from '../db'
import { emit } from '../events'

/** 没有新建派生内容表：沿用提案的来源元数据，防止保存回答后反向泄露附件。 */
export function conversationAttachmentIds(conversationId: string): string[] {
  return (
    getSqlite().prepare('SELECT source_id FROM conversation_attachments WHERE conversation_id=?').all(conversationId) as {
      source_id: string
    }[]
  ).map((r) => r.source_id)
}

export function protectProposalAttachments(proposalId: string, sourceIds: string[]): void {
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
  return !!getSqlite()
    .prepare(
      `SELECT 1 FROM proposals p JOIN json_each(CASE WHEN json_valid(p.ops) THEN json_extract(p.ops,'$.attachmentSourceIds') END) j LEFT JOIN sources s ON s.id=j.value WHERE p.note_id=? AND (s.id IS NULL OR s.space='attachment') LIMIT 1`
    )
    .get(noteId)
}
