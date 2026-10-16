import { and, eq, isNull, inArray } from 'drizzle-orm'
import { getDb, getSqlite } from '../db'
import { memoryProjectId } from './ai/memoryScope'
import { sources, conversations, decisions, conversationAttachments as conversationAttachmentsTable } from '../db/schema'

export interface ProjectSourceItem {
  itemType: 'note' | 'source'
  itemId: string
  title: string
  kind: string
  private: boolean
}

/** 只从当前有效的项目关系构造放行；调用者不能传任意 projectId 或 allow。 */
export function conversationProjectSources(conversationId: string): ProjectSourceItem[] {
  return getSqlite()
    .prepare(
      `SELECT ps.item_type AS itemType,ps.item_id AS itemId,
    CASE WHEN ps.item_type='note' THEN n.title ELSE s.title END AS title,
    CASE WHEN ps.item_type='note' THEN 'note' ELSE s.kind END AS kind,
    CASE WHEN ps.item_type='source' AND s.space='attachment' THEN 1 ELSE 0 END AS private
    FROM conversations c JOIN chat_projects p ON p.id=c.project_id AND p.deleted_at IS NULL
    JOIN project_sources ps ON ps.project_id=p.id
    LEFT JOIN sources s ON ps.item_type='source' AND s.id=ps.item_id
    LEFT JOIN notes n ON ps.item_type='note' AND n.id=ps.item_id
    WHERE c.id=? AND c.deleted_at IS NULL AND (
      (ps.item_type='note' AND n.deleted_at IS NULL AND n.ai_excluded=0) OR
      (ps.item_type='source' AND s.deleted_at IS NULL AND ((s.space='library' AND s.ai_excluded=0) OR (s.space='attachment' AND ps.origin<>'library')))
    ) ORDER BY ps.created_at,ps.item_id`
    )
    .all(conversationId)
    .map((r) => ({ ...(r as Omit<ProjectSourceItem, 'private'> & { private: number }), private: !!(r as { private: number }).private }))
}

export function isProjectSource(sourceId: string, conversationId: string | null): boolean {
  return !!conversationId && conversationProjectSources(conversationId).some((s) => s.itemType === 'source' && s.itemId === sourceId)
}

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

/** 资料归档或资料库引用不改变“本对话附件”的上下文上限。 */
export function isConversationAttachment(sourceId: string, conversationId: string | null): boolean {
  return (
    !!conversationId &&
    !!getDb()
      .select({ id: conversationAttachmentsTable.sourceId })
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

/** 有效所属对话或项目内的对话放行；归档后用户关闭 AI 权限时，旧关系不能绕过开关。 */
export function canReadSource(sourceId: string, conversationId: string | null): boolean {
  const s = getDb().select().from(sources).where(eq(sources.id, sourceId)).get()
  if (!s || s.deletedAt !== null) return false
  if (s.space === 'library') return !s.aiExcluded
  if (isProjectSource(sourceId, conversationId)) return true
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

/** Reply-derived inline chats keep their memory restriction even if the original attachment is later archived. */
function inheritedMemoryRestriction(conversationId: string): boolean {
  const row = getDb().select({ meta: conversations.meta }).from(conversations).where(eq(conversations.id, conversationId)).get()
  try {
    return !!row?.meta && JSON.parse(row.meta).suppressAttachmentMemory === true
  } catch {
    return true
  }
}

/** 仅删外部数据块不足以清掉模型复述；未归档附件参与过的对话不进入记忆整理。 */
export function hasPrivateAttachmentHistory(conversationId: string): boolean {
  return (
    inheritedMemoryRestriction(conversationId) ||
    conversationProjectSources(conversationId).some((s) => s.private) ||
    !!getSqlite()
      .prepare(
        `SELECT 1 FROM conversation_attachments ca JOIN sources s ON s.id=ca.source_id WHERE ca.conversation_id=? AND s.space='attachment'
    UNION ALL SELECT 1 FROM messages m JOIN json_each(CASE WHEN json_valid(m.context) THEN json_extract(m.context,'$.attachmentSourceIds') END) j LEFT JOIN sources s ON s.id=j.value WHERE m.conversation_id=? AND (s.id IS NULL OR s.space='attachment') LIMIT 1`
      )
      .get(conversationId, conversationId)
  )
}

/** 附件材料始终不是个人记忆输入；归档允许知识检索，但不把文件事实当成用户档案。 */
export function hasAttachmentHistory(conversationId: string): boolean {
  return (
    inheritedMemoryRestriction(conversationId) ||
    conversationProjectSources(conversationId).some((s) => s.private) ||
    !!getSqlite()
      .prepare(
        `SELECT 1 FROM conversation_attachments WHERE conversation_id=?
    UNION ALL SELECT 1 FROM messages m JOIN json_each(CASE WHEN json_valid(m.context) THEN json_extract(m.context,'$.attachmentSourceIds') END) j WHERE m.conversation_id=? AND EXISTS (SELECT 1 FROM conversation_attachments ca WHERE ca.source_id=j.value)
    UNION ALL SELECT 1 FROM messages m WHERE m.conversation_id=? AND json_valid(m.context) AND json_array_length(m.context,'$.projectPrivateSourceIds')>0 LIMIT 1`
      )
      .get(conversationId, conversationId, conversationId)
  )
}

/**
 * 记忆整理与 memory_remember 的门槛。
 * 仅限项目的对话：本项目的私有来源本来就只在本项目内可读，由此学到的记忆也只留在本项目，所以不因项目来源停用；
 * 对话自己的附件（只属于这一个对话）、继承来的限制、其他项目或已移除的私有材料仍然停用。
 */
export function memoryBlocked(conversationId: string): boolean {
  if (!memoryProjectId(conversationId)) return hasAttachmentHistory(conversationId)
  if (inheritedMemoryRestriction(conversationId)) return true
  const sqlite = getSqlite()
  if (
    sqlite
      .prepare(
        `SELECT 1 FROM conversation_attachments WHERE conversation_id=?
    UNION ALL SELECT 1 FROM messages m JOIN json_each(CASE WHEN json_valid(m.context) THEN json_extract(m.context,'$.attachmentSourceIds') END) j WHERE m.conversation_id=? AND EXISTS (SELECT 1 FROM conversation_attachments ca WHERE ca.source_id=j.value) LIMIT 1`
      )
      .get(conversationId, conversationId)
  )
    return true
  const own = new Set(
    conversationProjectSources(conversationId)
      .filter((s) => s.private)
      .map((s) => s.itemId)
  )
  const used = sqlite
    .prepare(
      `SELECT j.value AS id FROM messages m JOIN json_each(CASE WHEN json_valid(m.context) THEN json_extract(m.context,'$.projectPrivateSourceIds') END) j WHERE m.conversation_id=?`
    )
    .all(conversationId) as { id: string }[]
  return used.some((r) => !own.has(r.id))
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
