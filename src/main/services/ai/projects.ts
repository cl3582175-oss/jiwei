import { and, desc, eq, isNull } from 'drizzle-orm'
import { dialog, type BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getDb, getSqlite } from '../../db'
import { profileDb } from '../../db/profile'
import { assets, chatProjects, conversations, notes, projectSources, sources } from '../../db/schema'
import { FORMATS } from '@shared/formats'
import { enqueueSegment } from '../segmentJobs'
import { newId } from '../../lib/ids'
import { emit } from '../../events'
import { deviceId } from '../device'
import { deleteProjectMemories, promoteProjectMemories } from '../memory'
import { tr } from '../../lib/messages'
import { segmentTextStructured } from '../../lib/segment'
import { addAttachments, archiveAttachments, pickAttachments, retainDetachedAttachment } from '../attachments'
import { addUrl } from '../sources'
import { replaceSegments } from '../segments'
import { projectReadinessMany } from '../readiness'
import { requestIndex } from './indexer'
import {
  ProjectCreateSchema,
  ProjectUpdateSchema,
  ProjectSourcesInputSchema,
  type ChatProject,
  type ChatProjectConversation,
  type ChatProjectSource,
  type ProjectSourcesInput,
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
  if (!p) throw new Error(tr('项目不存在或已删除', 'Project not found'))
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
  if (p.memory === 'default' && patch.memory === 'project')
    throw new Error(tr('“仅限项目”记忆必须在创建项目时选择', 'Project-only memory must be chosen when creating a project'))
  if (p.memory === 'project' && patch.memory === 'default') {
    if (!patch.promoteMemories)
      throw new Error(tr('请确认将本项目的记忆设为全局可用', 'Confirm making project memories available globally'))
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
  if (mode !== 'recent' && mode !== 'delete') throw new Error(tr('无效的项目删除方式', 'Invalid project deletion mode'))
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

export function projectSourceList(id: string): ChatProjectSource[] {
  requireProject(id)
  const db = getDb()
  const relations = db
    .select()
    .from(projectSources)
    .where(eq(projectSources.projectId, id))
    .orderBy(desc(projectSources.createdAt), desc(projectSources.itemId))
    .all()
  const states = projectReadinessMany(
    id,
    relations.filter((row) => row.itemType === 'source').map((row) => row.itemId)
  )
  return relations.map((relation): ChatProjectSource => {
    if (relation.itemType === 'note') {
      const note = db.select().from(notes).where(eq(notes.id, relation.itemId)).get()
      return {
        ...relation,
        title: note ? note.title || tr('无标题', 'Untitled') : tr('笔记不可用', 'Note unavailable'),
        kind: note?.kind ?? 'other',
        readiness: null,
        space: 'library',
        available: !!note && note.deletedAt === null && !note.aiExcluded
      }
    }
    const source = db.select().from(sources).where(eq(sources.id, relation.itemId)).get()
    return {
      ...relation,
      title: source ? source.title || tr('无标题', 'Untitled') : tr('来源不可用', 'Source unavailable'),
      kind: source?.kind ?? 'other',
      readiness: states[relation.itemId] ?? null,
      space: source?.space ?? null,
      available: !!states[relation.itemId]
    }
  })
}

const sourceChanges = (): void => {
  emit('chatProjects:changed', {})
  emit('attachments:changed', {})
}

/** 保留同一来源、已识别页和批注，重新检测旧文件；项目权限在排队前由后端验证。 */
export function reprocessProjectSource(id: string, sourceId: string): void {
  requireProject(id)
  if (!projectReadinessMany(id, [sourceId])[sourceId])
    throw new Error(tr('来源不属于此项目或已不可用', 'Source is outside this project or unavailable'))
  const asset = getDb()
    .select({ ext: assets.ext })
    .from(sources)
    .innerJoin(assets, eq(assets.id, sources.assetId))
    .where(eq(sources.id, sourceId))
    .get()
  if (!asset || !FORMATS[asset.ext]?.parser) throw new Error(tr('这份来源暂不支持重新读取', 'This source cannot be reprocessed'))
  enqueueSegment(sourceId)
  sourceChanges()
}

export async function addProjectSources(id: string, input: ProjectSourcesInput, win?: BrowserWindow | null): Promise<ChatProjectSource[]> {
  requireProject(id)
  const parsed = ProjectSourcesInputSchema.parse(input)
  const db = getDb(),
    added = new Set<string>()
  if (parsed.origin === 'upload') {
    const paths = parsed.paths ?? (await pickAttachments(win ?? null))
    if (!paths.length) return []
    requireProject(id)
    const attachments = await addAttachments({ paths }, { projectId: id })
    // 每项失败都有现有附件流程提供的本地化原因；不要把无来源身份的失败行报告为添加成功。
    requireProject(id)
    const related = new Set(
      db
        .select({ id: projectSources.itemId })
        .from(projectSources)
        .where(and(eq(projectSources.projectId, id), eq(projectSources.itemType, 'source')))
        .all()
        .map((row) => row.id)
    )
    const failed = attachments.filter((attachment) => !related.has(attachment.sourceId))
    if (failed.length) {
      sourceChanges()
      throw new Error(
        failed.map((attachment) => `${attachment.name}: ${attachment.error ?? tr('添加失败', 'Could not add source')}`).join('\n')
      )
    }
    attachments.filter((attachment) => related.has(attachment.sourceId)).forEach((attachment) => added.add(`source:${attachment.sourceId}`))
  } else if (parsed.origin === 'url') {
    const source = addUrl(parsed.url, undefined, null, { projectId: id })
    added.add(`source:${source.id}`)
  } else if (parsed.origin === 'text') {
    const sourceId = newId(),
      now = Date.now()
    db.transaction(() => {
      requireProject(id)
      db.insert(sources)
        .values({
          id: sourceId,
          title: parsed.title,
          kind: 'document',
          originalName: `${parsed.title}.txt`,
          space: 'attachment',
          aiExcluded: true,
          accessedAt: now,
          createdAt: now,
          updatedAt: now,
          updatedBy: deviceId()
        })
        .run()
      db.insert(projectSources).values({ projectId: id, itemType: 'source', itemId: sourceId, origin: 'text', createdAt: now }).run()
      replaceSegments(sourceId, segmentTextStructured(parsed.text, 'plain'))
    })
    emit('sources:changed', { id: sourceId })
    requestIndex()
    added.add(`source:${sourceId}`)
  } else {
    const selected = [...new Set(parsed.notes), ...new Set(parsed.sources)]
    if (!selected.length) return []
    db.transaction(() => {
      requireProject(id)
      for (const noteId of new Set(parsed.notes)) {
        const note = db
          .select()
          .from(notes)
          .where(and(eq(notes.id, noteId), isNull(notes.deletedAt)))
          .get()
        if (!note || note.aiExcluded) throw new Error(tr('笔记不存在或设为不给 AI', 'Note not found or excluded from AI'))
      }
      for (const sourceId of new Set(parsed.sources)) {
        const source = db
          .select()
          .from(sources)
          .where(and(eq(sources.id, sourceId), isNull(sources.deletedAt)))
          .get()
        if (!source || source.space !== 'library' || source.aiExcluded)
          throw new Error(tr('请选择可供 AI 使用的资料库来源', 'Choose an AI-enabled library source'))
      }
      for (const [itemType, ids] of [
        ['note', parsed.notes],
        ['source', parsed.sources]
      ] as const) {
        for (const itemId of new Set(ids)) {
          db.insert(projectSources)
            .values({ projectId: id, itemType, itemId, origin: 'library', createdAt: Date.now() })
            .onConflictDoNothing()
            .run()
          added.add(`${itemType}:${itemId}`)
        }
      }
    })
  }
  requireProject(id)
  sourceChanges()
  return projectSourceList(id).filter((row) => added.has(`${row.itemType}:${row.itemId}`))
}

export function removeProjectSource(id: string, itemType: 'note' | 'source', itemId: string): void {
  requireProject(id)
  getDb().transaction((tx) => {
    const selected = and(eq(projectSources.projectId, id), eq(projectSources.itemType, itemType), eq(projectSources.itemId, itemId))
    const relation = tx.select().from(projectSources).where(selected).get()
    const source = itemType === 'source' ? tx.select().from(sources).where(eq(sources.id, itemId)).get() : null
    if (relation && source?.space === 'attachment' && source.deletedAt === null) retainDetachedAttachment(itemId, `project:${id}`)
    tx.delete(projectSources).where(selected).run()
  })
  sourceChanges()
  requestIndex()
}

export function archiveProjectSource(id: string, itemId: string, categoryId: string | null): void {
  requireProject(id)
  const db = getDb()
  const relation = db
    .select()
    .from(projectSources)
    .where(and(eq(projectSources.projectId, id), eq(projectSources.itemType, 'source'), eq(projectSources.itemId, itemId)))
    .get()
  const source = db
    .select()
    .from(sources)
    .where(and(eq(sources.id, itemId), isNull(sources.deletedAt)))
    .get()
  if (!relation || !source) throw new Error(tr('来源不属于此项目或已删除', 'Source does not belong to this project or was deleted'))
  if (source.space === 'library') return
  archiveAttachments([itemId], categoryId)
  sourceChanges()
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
