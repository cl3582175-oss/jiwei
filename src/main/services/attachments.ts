export { canReadSource } from './attachmentsAccess'
import { attachmentOwner as owner } from './attachmentsAccess'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { dialog, type BrowserWindow } from 'electron'
import { basename, extname, join } from 'node:path'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { getDb, getSqlite } from '../db'
import { assets, conversationAttachments as conversationAttachmentsTable, categories, jobs, sources } from '../db/schema'
import { emit, onMainEvent } from '../events'
import { newId } from '../lib/ids'
import { tr } from '../lib/messages'
import type { Attachment } from '@shared/types'
import type { z } from 'zod'
import type { AttachmentAddSchema } from '@shared/schemas'
import { assetPath, collectGarbage, importFile } from './assets'
import { deviceId } from './device'
import { EXT_KIND, getSource, purgeSourceData, trashSource } from './sources'
import { canSegment, enqueueSegment } from './jobKinds'
import { applySubtitleFile, canAutoTranscribe, enqueueTranscribe, findSidecarSubtitles, isMedia } from './asr'
import { enqueueMoss, mossStatus } from './moss'
import { recognizingSources } from './recognize'
import { listSegments, replaceSegments } from './segments'
import { requestIndex } from './ai/indexer'
import { compressImage } from '../lib/imageResize'

const PRIVATE_DRAFT = 'incognito-draft:'
const ORPHAN = 'orphan:'
const MB = 1024 * 1024
const CODE_EXTS = [
  'json',
  'yaml',
  'yml',
  'xml',
  'log',
  'py',
  'js',
  'ts',
  'tsx',
  'jsx',
  'java',
  'go',
  'rs',
  'c',
  'cpp',
  'h',
  'cs',
  'rb',
  'php',
  'sh',
  'sql',
  'ini',
  'toml'
]
export const ATTACHMENT_EXTS = [
  ...Object.keys(EXT_KIND).filter((ext) => !['doc', 'xls', 'ppt', 'mobi', 'azw3'].includes(ext)),
  'markdown',
  ...CODE_EXTS
]

const relations = (sourceId: string) =>
  getDb().select().from(conversationAttachmentsTable).where(eq(conversationAttachmentsTable.sourceId, sourceId)).all()
function privateSource(id: string): boolean {
  return relations(id).some((r) => r.conversationId.startsWith(PRIVATE_DRAFT) || owner(r.conversationId)?.incognito)
}
const changed = (sourceIds?: string[], conversationId?: string): void => emit('attachments:changed', { sourceIds, conversationId })

export function attachmentStatus(sourceIds: string[]): Attachment[] {
  if (!sourceIds.length) return []
  const db = getDb(),
    recognizing = new Map(recognizingSources(sourceIds).map((r) => [r.id, r.progress]))
  return sourceIds.flatMap((id) => {
    const source = getSource(id)
    if (!source) return []
    const tasks = db
      .select()
      .from(jobs)
      .orderBy(asc(jobs.createdAt))
      .all()
      .filter((j) => {
        try {
          return (JSON.parse(j.payload) as { sourceId?: string }).sourceId === id
        } catch {
          return false
        }
      })
    const pending = tasks.findLast((j) => j.status === 'queued' || j.status === 'running')
    const failed = tasks.findLast((j) => j.status === 'failed')
    const rec = recognizing.get(id),
      segments = (getSqlite().prepare('SELECT count(*) AS n FROM source_segments WHERE source_id=?').get(id) as { n: number }).n
    const status: Attachment['status'] = source.deletedAt
      ? 'failed'
      : rec !== undefined
        ? 'recognizing'
        : pending
          ? /transcribe|moss/.test(pending.kind)
            ? 'transcribing'
            : 'parsing'
          : segments || (source.kind === 'image' && !failed)
            ? 'ready'
            : failed
              ? 'failed'
              : isMedia(extname(source.originalName ?? '').slice(1))
                ? 'failed'
                : 'parsing'
    const error = source.deletedAt
      ? tr('附件已删除', 'Attachment deleted')
      : failed?.error
        ? /encrypt|password/i.test(failed.error)
          ? tr('文件有密码保护', 'The file is password protected')
          : failed.error
        : status === 'failed'
          ? tr('请先安装本地转写引擎，再重试转写', 'Install a local transcription engine and retry')
          : null
    return [
      {
        sourceId: id,
        name: source.originalName ?? source.title,
        kind: source.kind,
        size: source.size,
        mime: source.mime,
        thumbUrl: source.kind === 'image' ? source.assetUrl : null,
        status,
        progress: rec ?? pending?.progress ?? null,
        error,
        space: source.space ?? 'library',
        archivedCategoryId: source.categoryId,
        deleted: source.deletedAt !== null,
        conversations: relations(id).flatMap((r) => {
          const o = owner(r.conversationId)
          return o && !o.incognito ? [{ id: r.conversationId, title: o.title }] : []
        }),
        createdAt: source.createdAt
      }
    ]
  })
}

function failure(name: string, size: number, status: 'failed' | 'unsupported', error: string): Attachment {
  return {
    sourceId: newId(),
    name,
    size,
    kind: EXT_KIND[extname(name).slice(1).toLowerCase()] ?? 'other',
    mime: null,
    thumbUrl: null,
    status,
    progress: null,
    error,
    space: 'attachment',
    archivedCategoryId: null,
    deleted: false,
    conversations: [],
    createdAt: Date.now()
  }
}

function queue(sourceId: string, ext: string, path: string): void {
  if (canSegment(ext)) enqueueSegment(sourceId)
  else if (isMedia(ext)) {
    const sub = findSidecarSubtitles(path)
    if (sub) applySubtitleFile(sourceId, sub)
    else if (mossStatus().state === 'ready') enqueueMoss(sourceId)
    else if (canAutoTranscribe()) enqueueTranscribe(sourceId)
  }
}

export async function addAttachments(input: z.infer<typeof AttachmentAddSchema>): Promise<Attachment[]> {
  const db = getDb(),
    o = input.conversationId ? owner(input.conversationId) : null
  if (input.conversationId && !o) throw new Error('Conversation or decision not found')
  const incognito = o?.incognito || input.incognito
  const temp = await mkdtemp(join(tmpdir(), 'jiwei-attachment-'))
  const inputs: { path?: string; name: string; data?: Uint8Array }[] = [
    ...(input.paths ?? []).map((path) => ({ path, name: basename(path) })),
    ...(input.files ?? [])
  ]
  const result: Attachment[] = []
  try {
    for (const [index, entry] of inputs.entries()) {
      let size = entry.data?.byteLength ?? 0
      try {
        if (index >= 10) {
          result.push(failure(entry.name, size, 'failed', tr('一条消息最多 10 个附件', 'At most 10 attachments per message')))
          continue
        }
        const ext = extname(entry.name).slice(1).toLowerCase(),
          legacy = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' }[ext]
        if (legacy) {
          result.push(failure(entry.name, size, 'unsupported', tr(`请另存为 ${legacy} 再添加`, `Save as ${legacy} and add again`)))
          continue
        }
        if (!ATTACHMENT_EXTS.includes(ext)) {
          result.push(failure(entry.name, size, 'unsupported', tr('格式不支持', 'Unsupported format')))
          continue
        }
        if (entry.data && size > 25 * MB) {
          result.push(failure(entry.name, size, 'failed', tr('文件太大（25 MB 以内）', 'File too large (up to 25 MB)')))
          continue
        }
        let path = entry.path ?? join(temp, `${index}-${basename(entry.name)}`)
        if (entry.data) await writeFile(path, entry.data)
        const info = await stat(path)
        if (!info.isFile()) throw new Error(tr('请选择文件', 'Choose a file'))
        size = info.size
        const kind = EXT_KIND[ext] ?? 'document',
          limit = isMedia(ext) ? 2048 : kind === 'image' ? 30 : 200
        if (size > limit * MB) {
          result.push(
            failure(
              entry.name,
              size,
              'failed',
              tr(
                `文件太大（${limit === 2048 ? '2 GB' : `${limit} MB`} 以内）`,
                `File too large (up to ${limit === 2048 ? '2 GB' : `${limit} MB`})`
              )
            )
          )
          continue
        }
        if (kind === 'image' && size > 8 * MB) {
          path = join(temp, `${index}-compressed.jpg`)
          await writeFile(path, compressImage(await readFile(entry.path ?? join(temp, `${index}-${basename(entry.name)}`))))
        }
        const { row: asset } = await importFile(path)
        const candidates = db
          .select()
          .from(sources)
          .where(and(eq(sources.assetId, asset.id), isNull(sources.deletedAt)))
          .all()
        const existing = incognito
          ? candidates.find(
              (s) =>
                s.space === 'attachment' &&
                !!input.conversationId &&
                relations(s.id).some((r) => r.conversationId === input.conversationId) &&
                relations(s.id).every((r) => r.conversationId === input.conversationId)
            )
          : (candidates.find((s) => s.space === 'library') ?? candidates.find((s) => s.space === 'attachment' && !privateSource(s.id)))
        const id = existing?.id ?? newId(),
          now = Date.now()
        if (!existing) {
          db.insert(sources)
            .values({
              id,
              title: entry.name.replace(/\.[^.]+$/, ''),
              kind,
              assetId: asset.id,
              originalName: basename(entry.name),
              space: 'attachment',
              aiExcluded: true,
              accessedAt: now,
              createdAt: now,
              updatedAt: now,
              updatedBy: deviceId()
            })
            .run()
          if (incognito && !input.conversationId)
            db.insert(conversationAttachmentsTable)
              .values({ conversationId: PRIVATE_DRAFT + newId(), sourceId: id, createdAt: now })
              .run()
          queue(id, asset.ext, entry.path ?? path)
        }
        if (input.conversationId) bindAttachments(input.conversationId, [id], null)
        result.push(...attachmentStatus([id]))
      } catch (e) {
        result.push(failure(entry.name, size, 'failed', e instanceof Error ? e.message : String(e)))
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
  changed(
    result.filter((a) => !['failed', 'unsupported'].includes(a.status)).map((a) => a.sourceId),
    input.conversationId ?? undefined
  )
  return result
}

/** 无痕与普通会话只能共享资产，不能共享可清理的资料身份。 */
export function bindAttachments(conversationId: string, sourceIds: string[], messageId: string | null): string[] {
  const db = getDb(),
    target = owner(conversationId)
  if (!target) throw new Error('Conversation or decision not found')
  const bound: string[] = []
  db.transaction(() => {
    for (const sourceId of new Set(sourceIds)) {
      let s = db.select().from(sources).where(eq(sources.id, sourceId)).get()
      if (!s || s.deletedAt !== null) throw new Error(tr('附件已删除', 'Attachment deleted'))
      if (s.space === 'library' && s.aiExcluded) throw new Error(tr('这份资料设为不给 AI', 'This source is excluded from AI'))
      const refs = relations(sourceId)
      if (
        (target.incognito &&
          (s.space === 'library' ||
            refs.some((r) => !r.conversationId.startsWith(PRIVATE_DRAFT) && r.conversationId !== conversationId))) ||
        (!target.incognito && privateSource(sourceId))
      ) {
        const copy = { ...s, id: newId(), space: 'attachment' as const, aiExcluded: true, createdAt: Date.now(), updatedAt: Date.now() }
        db.insert(sources).values(copy).run()
        replaceSegments(
          copy.id,
          listSegments(s.id).map(({ kind, text, locator }) => ({ kind, text, locator }))
        )
        if (!listSegments(copy.id).length && s.assetId) {
          const a = db.select().from(assets).where(eq(assets.id, s.assetId)).get()
          if (a) queue(copy.id, a.ext, assetPath(a.id, a.ext))
        }
        s = copy
      }
      if (target.incognito)
        db.delete(conversationAttachmentsTable)
          .where(
            and(
              eq(conversationAttachmentsTable.sourceId, s.id),
              sql`${conversationAttachmentsTable.conversationId} LIKE ${PRIVATE_DRAFT + '%'}`
            )
          )
          .run()
      const prior = db
        .select()
        .from(conversationAttachmentsTable)
        .where(and(eq(conversationAttachmentsTable.conversationId, conversationId), eq(conversationAttachmentsTable.sourceId, s.id)))
        .get()
      db.insert(conversationAttachmentsTable)
        .values({ conversationId, sourceId: s.id, messageId, createdAt: Date.now() })
        .onConflictDoUpdate({
          target: [conversationAttachmentsTable.conversationId, conversationAttachmentsTable.sourceId],
          set: { removedAt: null, ...(prior?.messageId ? {} : { messageId }), ...(prior?.removedAt ? { fullTextSent: false } : {}) }
        })
        .run()
      bound.push(s.id)
    }
  })
  requestIndex()
  changed(bound, conversationId)
  return bound
}

export function conversationAttachments(conversationId: string): Attachment[] {
  const ids = getDb()
    .select({ id: conversationAttachmentsTable.sourceId })
    .from(conversationAttachmentsTable)
    .where(and(eq(conversationAttachmentsTable.conversationId, conversationId), isNull(conversationAttachmentsTable.removedAt)))
    .orderBy(asc(conversationAttachmentsTable.createdAt))
    .all()
    .map((r) => r.id)
  return attachmentStatus(ids)
}
// 函数与表有相同的公开名称，表别名只在查询中使用。

export function removeFromConversation(conversationId: string, sourceId: string): void {
  getDb()
    .update(conversationAttachmentsTable)
    .set({ removedAt: Date.now() })
    .where(and(eq(conversationAttachmentsTable.conversationId, conversationId), eq(conversationAttachmentsTable.sourceId, sourceId)))
    .run()
  changed([sourceId], conversationId)
}

export function listAttachmentSpace(filter: { state: 'unarchived' | 'archived' | 'all'; query?: string }): Attachment[] {
  const rows = getDb()
    .select({ id: sources.id, space: sources.space })
    .from(sources)
    .where(isNull(sources.deletedAt))
    .orderBy(asc(sources.createdAt))
    .all()
  const ids = rows
    .filter(
      (s) =>
        (s.space === 'attachment' || relations(s.id).length) &&
        !privateSource(s.id) &&
        (filter.state === 'all' || (filter.state === 'unarchived' ? s.space === 'attachment' : s.space === 'library'))
    )
    .map((s) => s.id)
  const query = filter.query?.trim().toLocaleLowerCase()
  return attachmentStatus(ids).filter((a) => !query || a.name.toLocaleLowerCase().includes(query))
}

export function archiveAttachments(sourceIds: string[], categoryId: string | null): void {
  if (
    categoryId &&
    !getDb()
      .select()
      .from(categories)
      .where(and(eq(categories.id, categoryId), eq(categories.kind, 'source'), isNull(categories.deletedAt)))
      .get()
  )
    throw new Error('Category not found')
  if (sourceIds.some(privateSource)) throw new Error(tr('无痕附件不能归档', 'Incognito attachments cannot be archived'))
  getDb()
    .update(sources)
    .set({ space: 'library', aiExcluded: false, categoryId, updatedAt: Date.now(), updatedBy: deviceId() })
    .where(and(inArray(sources.id, sourceIds), isNull(sources.deletedAt)))
    .run()
  for (const id of sourceIds) emit('sources:changed', { id })
  requestIndex()
  changed(sourceIds)
}

export function deleteAttachments(sourceIds: string[]): void {
  getDb().transaction(() => {
    for (const id of sourceIds) {
      getDb().update(sources).set({ space: 'attachment', aiExcluded: true, categoryId: null }).where(eq(sources.id, id)).run()
      trashSource(id)
    }
  })
  requestIndex()
  changed(sourceIds)
}
export const unarchivedCount = (): number =>
  (
    getSqlite()
      .prepare(
        "SELECT count(*) AS n FROM sources s WHERE s.space='attachment' AND s.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM conversation_attachments ca LEFT JOIN conversations c ON c.id=ca.conversation_id WHERE ca.source_id=s.id AND (c.incognito=1 OR ca.conversation_id LIKE 'incognito-draft:%'))"
      )
      .get() as { n: number }
  ).n

export async function cleanupDrafts(now = Date.now()): Promise<number> {
  const drafts = getDb()
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(
        eq(sources.space, 'attachment'),
        sql`${sources.createdAt} < ${now - 86400000}`,
        sql`NOT EXISTS (SELECT 1 FROM conversation_attachments a WHERE a.source_id=${sources.id} AND a.conversation_id NOT LIKE ${PRIVATE_DRAFT + '%'})`
      )
    )
    .all()
  for (const { id } of drafts) purgeSourceData(id)
  if (drafts.length) await collectGarbage()
  return drafts.length
}

/** 调用方在删除会话的同一事务内执行。孤儿关系保留来源历史，防止被当成草稿清掉。 */
export function detachConversationAttachments(conversationId: string): void {
  const db = getDb(),
    incognito = owner(conversationId)?.incognito
  const ids = db
    .select({ id: conversationAttachmentsTable.sourceId })
    .from(conversationAttachmentsTable)
    .where(eq(conversationAttachmentsTable.conversationId, conversationId))
    .all()
    .map((r) => r.id)
  db.delete(conversationAttachmentsTable).where(eq(conversationAttachmentsTable.conversationId, conversationId)).run()
  for (const id of ids) {
    const s = getSource(id)
    if (incognito && s?.space === 'attachment') purgeSourceData(id)
    else if (s?.space === 'attachment' && !relations(id).length)
      db.insert(conversationAttachmentsTable)
        .values({ conversationId: ORPHAN + conversationId, sourceId: id, createdAt: Date.now() })
        .run()
  }
  changed(ids, conversationId)
}

export async function pickAttachments(win: BrowserWindow | null): Promise<string[]> {
  const options: Electron.OpenDialogOptions = {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: tr('支持的附件', 'Supported attachments'), extensions: ATTACHMENT_EXTS },
      { name: tr('所有文件', 'All files'), extensions: ['*'] }
    ]
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths
}

/** 状态变动沿用作业/资料事件，附件 UI 不需要另造后台轮询器。 */
export function observeAttachmentChanges(): () => void {
  const dispose = [
    onMainEvent('jobs:changed', () => changed()),
    onMainEvent('segments:changed', () => changed()),
    onMainEvent('sources:changed', () => changed())
  ]
  return () => dispose.forEach((fn) => fn())
}
