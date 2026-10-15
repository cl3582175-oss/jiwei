import { getSqlite } from '../db'
import { emit } from '../events'
import { attachmentOrigins } from '../lib/attachmentOrigins'
import { readNoteState } from './noteState'
import { canReadSource, isConversationAttachment, isProjectSource } from './attachmentsAccess'

/** 文档与提案的来源记录都保留；删除来源不意味着派生内容变成公开。 */
function attachmentSourcesOf(noteId: string): string[] {
  const proposals = getSqlite()
    .prepare(
      `SELECT DISTINCT j.value AS id FROM proposals p,
      json_each(CASE WHEN json_valid(p.ops) THEN json_extract(p.ops,'$.attachmentSourceIds') END) j
      WHERE p.note_id=? AND typeof(j.value)='text'`
    )
    .all(noteId) as { id: string }[]
  return [...new Set([...attachmentOrigins(readNoteState(noteId)), ...proposals.map((r) => r.id)])]
}

/** 笔记现在因哪些未归档附件而受限（空数组 = 没有附件限制）。 */
export function privateAttachmentsOf(noteId: string): string[] {
  const lookup = getSqlite().prepare('SELECT space FROM sources WHERE id=?')
  const released = getSqlite().prepare('SELECT 1 FROM released_attachments WHERE source_id=?')
  return attachmentSourcesOf(noteId).filter((id) => {
    const source = lookup.get(id) as { space: string } | undefined
    return source ? source.space === 'attachment' : !released.get(id)
  })
}

/** 重新计算笔记的生效排除：用户的选择 OR 含未归档附件。所有系统写入都走这里。 */
export function refreshNotePrivacy(noteIds: string[]): void {
  const sql = getSqlite()
  const changed: string[] = []
  sql.transaction(() => {
    for (const id of new Set(noteIds)) {
      const row = sql.prepare('SELECT user_ai_excluded,ai_excluded FROM notes WHERE id=?').get(id) as
        { user_ai_excluded: number; ai_excluded: number } | undefined
      if (!row) continue
      const excluded = Number(!!row.user_ai_excluded || privateAttachmentsOf(id).length > 0)
      if (excluded !== row.ai_excluded) {
        sql.prepare('UPDATE notes SET ai_excluded=? WHERE id=?').run(excluded, id)
        changed.push(id)
      }
    }
  })()
  if (changed.length) emit('notes:changed', { ids: changed })
}

/** 这篇笔记能否在给定对话（后台任务传发起它的对话）里被 AI 使用 / 写入提案。 */
export function canUseNote(noteId: string, conversationId: string | null): boolean {
  const row = getSqlite().prepare('SELECT user_ai_excluded,deleted_at FROM notes WHERE id=?').get(noteId) as
    { user_ai_excluded: number; deleted_at: number | null } | undefined
  if (!row || row.deleted_at !== null || row.user_ai_excluded) return false
  return privateAttachmentsOf(noteId).every(
    (id) => (isConversationAttachment(id, conversationId) || isProjectSource(id, conversationId)) && canReadSource(id, conversationId)
  )
}

/** 归档即公开：记下来源，彻底删除资料后派生笔记也不会被重新锁住。 */
export function releaseAttachments(sourceIds: string[]): void {
  const insert = getSqlite().prepare('INSERT OR IGNORE INTO released_attachments(source_id,released_at) VALUES(?,?)')
  for (const id of sourceIds) insert.run(id, Date.now())
}
/** 附件重新变为私有（如在附件管理里删除已归档附件）时撤销公开记录。 */
export function unreleaseAttachments(sourceIds: string[]): void {
  const remove = getSqlite().prepare('DELETE FROM released_attachments WHERE source_id=?')
  for (const id of sourceIds) remove.run(id)
}

/** 通常只检查生效的系统锁；附件重新变为私有时也检查已解锁派生笔记，防止漏锁。 */
export function refreshAttachmentNotePrivacy(sourceIds: string[], includeUnlocked = false): void {
  if (!sourceIds.length) return
  const wanted = new Set(sourceIds)
  const rows = getSqlite()
    .prepare(`SELECT id FROM notes WHERE user_ai_excluded=0${includeUnlocked ? '' : ' AND ai_excluded=1'}`)
    .all() as { id: string }[]
  const ids = rows.filter(({ id }) => attachmentSourcesOf(id).some((sourceId) => wanted.has(sourceId))).map((r) => r.id)
  refreshNotePrivacy(ids)
  // 来源归档也改变用户锁定笔记的 attachmentOnly 展示，即使生效值仍为 1。
  emit('notes:changed', { ids })
}

const BACKFILL = 'longTaskPrivacyBackfilled'
/** 迁移后首次启动只检查本地来源元数据，绝不向模型发送正文。 */
export function backfillNotePrivacy(): void {
  const sql = getSqlite()
  if (sql.prepare('SELECT 1 FROM settings WHERE key=?').get(BACKFILL)) return
  sql.transaction(() => {
    const legacy = sql.prepare('SELECT id FROM notes WHERE ai_excluded=1').all() as { id: string }[]
    const derived = legacy.filter(({ id }) => attachmentSourcesOf(id).length > 0).map((r) => r.id)
    for (const id of derived) sql.prepare('UPDATE notes SET user_ai_excluded=0 WHERE id=?').run(id)
    refreshNotePrivacy(derived)
    sql.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(BACKFILL, 'true')
  })()
}
