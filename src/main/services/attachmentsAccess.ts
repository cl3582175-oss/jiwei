import { and, eq, isNull, inArray } from 'drizzle-orm'
import { getDb, getSqlite } from '../db'
import { sources, conversations, decisions, conversationAttachments as conversationAttachmentsTable } from '../db/schema'

export function attachmentOwner(id: string): { incognito: boolean; title: string } | null {
  const db = getDb(),
    c = db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
      .get()
  if (c) return { incognito: c.incognito, title: c.title }
  const d = db
    .select()
    .from(decisions)
    .where(and(eq(decisions.id, id), isNull(decisions.deletedAt)))
    .get()
  return d ? { incognito: false, title: d.question } : null
}

/** 所属会话之外永不放行；归档后用户再次关闭 AI 权限时，旧关系不能绕过开关。 */
export function canReadSource(sourceId: string, conversationId: string | null): boolean {
  const s = getDb().select().from(sources).where(eq(sources.id, sourceId)).get()
  if (!s || s.deletedAt !== null) return false
  if (s.space === 'library') return !s.aiExcluded
  return (
    !!conversationId &&
    !!attachmentOwner(conversationId) &&
    !!getDb()
      .select()
      .from(conversationAttachmentsTable)
      .where(
        and(
          eq(conversationAttachmentsTable.conversationId, conversationId),
          eq(conversationAttachmentsTable.sourceId, sourceId),
          isNull(conversationAttachmentsTable.removedAt)
        )
      )
      .get()
  )
}

/** 附件撤销后，不能从旧助手回答再次把原文带进请求。 */
export function attachmentHistoryReadable(context: string | null, conversationId: string): boolean {
  if (!context) return true
  try {
    const ids = (JSON.parse(context) as { attachmentSourceIds?: string[] }).attachmentSourceIds ?? []
    return ids.every((id) => canReadSource(id, conversationId))
  } catch {
    return false
  }
}

/** 仅删外部数据块不足以清掉模型复述；未归档附件参与过的对话不进入记忆整理。 */
export function hasPrivateAttachmentHistory(conversationId: string): boolean {
  return !!getSqlite()
    .prepare(
      `SELECT 1 FROM conversation_attachments ca JOIN sources s ON s.id=ca.source_id WHERE ca.conversation_id=? AND s.space='attachment'
    UNION ALL SELECT 1 FROM messages m JOIN json_each(CASE WHEN json_valid(m.context) THEN json_extract(m.context,'$.attachmentSourceIds') END) j LEFT JOIN sources s ON s.id=j.value WHERE m.conversation_id=? AND (s.id IS NULL OR s.space='attachment') LIMIT 1`
    )
    .get(conversationId, conversationId)
}

/** 附件材料始终不是个人记忆输入；归档允许知识检索，但不把文件事实当成用户档案。 */
export function hasAttachmentHistory(conversationId: string): boolean {
  return !!getSqlite()
    .prepare(
      `SELECT 1 FROM conversation_attachments WHERE conversation_id=?
    UNION ALL SELECT 1 FROM messages m JOIN json_each(CASE WHEN json_valid(m.context) THEN json_extract(m.context,'$.attachmentSourceIds') END) j WHERE m.conversation_id=? AND EXISTS (SELECT 1 FROM conversation_attachments ca WHERE ca.source_id=j.value) LIMIT 1`
    )
    .get(conversationId, conversationId)
}

/** 参谋备忘录可能复述原文；派生摘要不能成为洞察等其他AI入口的材料。 */
export function hasPrivateDecisionAttachments(decisionId: string): boolean {
  const db = getDb(),
    row = db.select({ memo: decisions.memo }).from(decisions).where(eq(decisions.id, decisionId)).get()
  if (!row?.memo) return false
  try {
    const ids = (JSON.parse(row.memo) as { attachmentSourceIds?: string[] }).attachmentSourceIds ?? []
    if (!ids.length) return false
    const all = db.select().from(sources).where(inArray(sources.id, ids)).all()
    return ids.some((id) => {
      const s = all.find((s) => s.id === id)
      return !s || s.space === 'attachment' || s.aiExcluded || s.deletedAt !== null
    })
  } catch {
    return true
  }
}
