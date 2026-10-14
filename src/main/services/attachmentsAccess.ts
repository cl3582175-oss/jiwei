import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '../db'
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
