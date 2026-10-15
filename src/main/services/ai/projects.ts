import { and, desc, eq, isNull } from 'drizzle-orm'
import { dialog, type BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getDb, getSqlite } from '../../db'
import { profileDb } from '../../db/profile'
import { chatProjects, conversations, projectSources, sources } from '../../db/schema'
import { newId } from '../../lib/ids'
import { emit } from '../../events'
import { deviceId } from '../device'
import { deleteProjectMemories, promoteProjectMemories } from '../memory'
import {
  ProjectCreateSchema,
  ProjectUpdateSchema,
  type ChatProject,
  type ChatProjectConversation,
  type ProjectCreate,
  type ProjectUpdate
} from '@shared/chatProjects'

type Row = typeof chatProjects.$inferSelect
const toProject = (r: Row): ChatProject => ({
  ...r,
  memoryCount: (profileDb().prepare('SELECT count(*) AS n FROM memories WHERE project_id=?').get(r.id) as { n: number }).n
})
export function listProjects(): ChatProject[] {
  return getDb()
    .select()
    .from(chatProjects)
    .where(isNull(chatProjects.deletedAt))
    .orderBy(desc(chatProjects.pinned), desc(chatProjects.createdAt))
    .all()
    .map(toProject)
}
export function getProject(id: string): ChatProject | null {
  const r = getDb()
    .select()
    .from(chatProjects)
    .where(and(eq(chatProjects.id, id), isNull(chatProjects.deletedAt)))
    .get()
  return r ? toProject(r) : null
}
export function requireProject(id: string): ChatProject {
  const p = getProject(id)
  if (!p) throw new Error('Project not found')
  return p
}
export function createProject(input: ProjectCreate): ChatProject {
  const parsed = ProjectCreateSchema.parse(input),
    now = Date.now(),
    id = newId()
  getDb()
    .insert(chatProjects)
    .values({ ...parsed, color: parsed.color ?? null, id, createdAt: now, updatedAt: now, updatedBy: deviceId() })
    .run()
  emit('chatProjects:changed', {})
  return requireProject(id)
}
export function updateProject(id: string, input: ProjectUpdate): ChatProject {
  const p = requireProject(id),
    patch = ProjectUpdateSchema.parse(input)
  if (p.memory === 'default' && patch.memory === 'project') throw new Error('Project-only memory must be chosen when creating a project')
  if (p.memory === 'project' && patch.memory === 'default') {
    if (!patch.promoteMemories) throw new Error('Confirm making project memories available globally')
    promoteProjectMemories(id)
  }
  const { promoteMemories: _confirmation, ...fields } = patch
  void _confirmation
  getDb()
    .update(chatProjects)
    .set({ ...fields, updatedAt: Date.now(), updatedBy: deviceId() })
    .where(eq(chatProjects.id, id))
    .run()
  emit('chatProjects:changed', {})
  return requireProject(id)
}
export async function projectConversations(id: string): Promise<ChatProjectConversation[]> {
  requireProject(id)
  const { listConversations } = await import('./chat')
  return listConversations()
    .filter((c) => c.projectId === id)
    .map((c) => ({
      ...c,
      lastMessageAt: c.lastMessageAt ?? c.createdAt,
      summary:
        (
          getSqlite()
            .prepare("SELECT content FROM messages WHERE conversation_id=? AND role='user' ORDER BY created_at,rowid LIMIT 1")
            .get(c.id) as { content: string } | undefined
        )?.content
          .replace(/\s+/g, ' ')
          .slice(0, 180) ?? ''
    }))
}
export async function removeProject(id: string, mode: 'recent' | 'delete'): Promise<void> {
  if (mode !== 'recent' && mode !== 'delete') throw new Error('Invalid project deletion mode')
  const db = getDb()
  const p = db.select().from(chatProjects).where(eq(chatProjects.id, id)).get()
  if (!p) return
  // Revoke active runs before any asynchronous cleanup; retries can finish a tombstoned project.
  db.update(chatProjects)
    .set({ deletedAt: p.deletedAt ?? Date.now(), updatedAt: Date.now(), updatedBy: deviceId() })
    .where(eq(chatProjects.id, id))
    .run()
  emit('chatProjects:changed', {})
  // Each part is idempotent: a failed deletion can be retried without promoting private data.
  deleteProjectMemories(id)
  if (mode === 'delete') {
    const chat = await import('./chat')
    for (const c of db.select({ id: conversations.id }).from(conversations).where(eq(conversations.projectId, id)).all()) {
      if (chat.getConversation(c.id)) await chat.deleteConversation(c.id)
    }
  } else
    db.update(conversations)
      .set({ projectId: null, updatedAt: Date.now(), updatedBy: deviceId() })
      .where(eq(conversations.projectId, id))
      .run()
  const relations = db.select().from(projectSources).where(eq(projectSources.projectId, id)).all()
  for (const relation of relations) {
    if (relation.origin === 'library' || relation.itemType !== 'source') continue
    const s = db.select().from(sources).where(eq(sources.id, relation.itemId)).get()
    if (s?.space === 'attachment' && s.deletedAt === null) (await import('../sources')).trashSource(s.id)
  }
  db.transaction((tx) => {
    tx.delete(projectSources).where(eq(projectSources.projectId, id)).run()
    tx.update(chatProjects)
      .set({ deletedAt: Date.now(), updatedAt: Date.now(), updatedBy: deviceId() })
      .where(eq(chatProjects.id, id))
      .run()
  })
  emit('chatProjects:changed', {})
  emit('attachments:changed', {})
  emit('memory:changed', {})
}
const filename = (s: string): string =>
  Array.from(s, (c) => (c.charCodeAt(0) < 32 ? '_' : c))
    .join('')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '_')
    .trim()
    .slice(0, 80) || 'conversation'
export async function exportMarkdown(id: string, win?: BrowserWindow | null): Promise<string | null> {
  const p = requireProject(id)
  const options = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return null
  const folder = join(result.filePaths[0], `${filename(p.name)}-${p.id.slice(-8)}`)
  await mkdir(folder, { recursive: true })
  const chat = await import('./chat')
  for (const c of await projectConversations(id)) {
    const text =
      [`# ${c.title}`, ...chat.listMessages(c.id).map((m) => `## ${m.role === 'user' ? 'User' : 'Jiwei'}\n\n${m.content}`)].join('\n\n') +
      '\n'
    await writeFile(join(folder, `${filename(c.title)}-${c.id}.md`), text, 'utf8')
  }
  return folder
}
