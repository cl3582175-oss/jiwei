import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '../../db'
import { chatProjects, conversations } from '../../db/schema'

/** 只读取有效对话所属的有效项目，避免通过 projects 服务形成 chat / memory 的循环依赖。 */
export function conversationProject(conversationId: string): typeof chatProjects.$inferSelect | null {
  const row = getDb()
    .select({ project: chatProjects })
    .from(conversations)
    .innerJoin(chatProjects, eq(conversations.projectId, chatProjects.id))
    .where(and(eq(conversations.id, conversationId), isNull(conversations.deletedAt), isNull(chatProjects.deletedAt)))
    .get()
  return row?.project ?? null
}

/** NULL = 普通 / 默认记忆项目使用的全局记忆；仅限项目时返回项目 ID。 */
export function memoryProjectId(conversationId: string): string | null {
  const project = conversationProject(conversationId)
  return project?.memory === 'project' ? project.id : null
}
