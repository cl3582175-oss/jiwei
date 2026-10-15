import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { sources } from '../db/schema'
import { tr } from '../lib/messages'

/** 后台任务标题里的资料名：对话附件不显示文件名（任务列表跨对话可见）。 */
export function sourceJobTitle(id: string): string {
  const s = getDb().select({ title: sources.title, space: sources.space }).from(sources).where(eq(sources.id, id)).get()
  return s?.space === 'attachment' ? tr('对话附件', 'Chat attachment') : (s?.title ?? id)
}
