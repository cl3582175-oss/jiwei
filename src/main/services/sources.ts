import log from 'electron-log/main'
import { recordingAudio, recordingForSource, purgeRecording } from './recording'
import { recordings } from '../db/schema'
import { enqueueMoss, mossStatus } from './moss'
import { basename, extname } from 'path'
import { stat } from 'fs/promises'
import { BrowserWindow, dialog, shell } from 'electron'
import { and, desc, eq, inArray, isNull, like, or, type SQL } from 'drizzle-orm'
import { getDb, getSqlite } from '../db'
import { emit } from '../events'
import { assets, sources, taggings, sourcePages, conversationAttachments, chunks, jobs, links, annotations } from '../db/schema'
import { newId } from '../lib/ids'
import { deviceId } from './device'
import { recordActivity } from './stats'
import { deletedCategoryIds, descendantIds } from './categories'
import { entitiesWithTag, tagIdsFor } from './tags'
import { assetPath, assetUrl, collectGarbage, importBytes, importFile } from './assets'
import { cancelJob } from './jobs'
import { canSegment, enqueueFetch, enqueueSegment } from './jobKinds'
import { applySubtitleFile, canAutoTranscribe, enqueueTranscribe, findSidecarSubtitles, isMedia } from './asr'
import { deleteSegments, listSegments } from './segments'
import type { ImportResult, Source, SourceKind, SourceQuery, SourceUpdate } from '@shared/types'

export const EXT_KIND: Record<string, SourceKind> = {
  pdf: 'pdf',
  epub: 'book',
  mobi: 'book',
  azw3: 'book',
  mp4: 'video',
  mov: 'video',
  mkv: 'video',
  webm: 'video',
  avi: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  flac: 'audio',
  ogg: 'audio',
  aac: 'audio',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  heic: 'image',
  avif: 'image',
  doc: 'document',
  docx: 'document',
  txt: 'document',
  md: 'document',
  ppt: 'document',
  pptx: 'document',
  xls: 'document',
  xlsx: 'document',
  csv: 'document',
  html: 'document',
  htm: 'document'
}

function query(conds: SQL[]): Source[] {
  const rows = getDb()
    .select({ s: sources, a: assets })
    .from(sources)
    .leftJoin(assets, eq(sources.assetId, assets.id))
    .where(and(...conds))
    .orderBy(desc(sources.createdAt))
    .all()
  const tagMap = tagIdsFor(
    'source',
    rows.map((r) => r.s.id)
  )
  return rows.map(({ s, a }) => ({
    id: s.id,
    title: s.title,
    kind: s.kind as SourceKind,
    assetUrl: s.kind === 'recording' ? (recordingAudio(s.id) ? `jiwei://recording/${s.id}` : null) : a ? assetUrl(a.id, a.ext) : null,
    recordingScene: s.kind === 'recording' ? recordingForSource(s.id)?.scene : undefined,
    originalName: s.originalName,
    mime: a?.mime ?? null,
    size: a?.size ?? 0,
    url: s.url,
    author: s.author,
    publishedAt: s.publishedAt,
    accessedAt: s.accessedAt,
    categoryId: s.categoryId,
    aiExcluded: s.aiExcluded,
    space: s.space,
    tagIds: tagMap.get(s.id) ?? [],
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    deletedAt: s.deletedAt
  }))
}

export function listSources(q: SourceQuery): Source[] {
  const conds: SQL[] = [isNull(sources.deletedAt), eq(sources.space, q.space ?? 'library')]
  if (q.categoryId !== undefined) {
    if (q.categoryId === null) {
      const dead = deletedCategoryIds()
      conds.push(dead.length ? or(isNull(sources.categoryId), inArray(sources.categoryId, dead))! : isNull(sources.categoryId))
    } else {
      conds.push(inArray(sources.categoryId, q.includeDescendants ? descendantIds(q.categoryId) : [q.categoryId]))
    }
  }
  if (q.kind) conds.push(q.kind === 'audio' ? inArray(sources.kind, ['audio', 'recording']) : eq(sources.kind, q.kind))
  if (q.tagId) conds.push(inArray(sources.id, entitiesWithTag('source', q.tagId)))
  if (q.search?.trim()) {
    const pat = `%${q.search.trim()}%`
    conds.push(or(like(sources.title, pat), like(sources.originalName, pat), like(sources.url, pat), like(sources.author, pat))!)
  }
  const result = query(conds)
  if (!q.scene && !q.seriesId && !q.personId && !q.from && !q.to) return result
  return result.filter((s) => {
    const r = recordingForSource(s.id)
    if ((q.scene && (r?.scene ?? 'unspecified') !== q.scene) || (q.seriesId && r?.seriesId !== q.seriesId)) return false
    const date = new Date(r?.startedAt ?? s.accessedAt).toLocaleDateString('sv')
    if ((q.from && date < q.from) || (q.to && date > q.to)) return false
    return (
      !q.personId ||
      listSegments(s.id).some((seg) => seg.locator.personId === q.personId) ||
      (!!r && (JSON.parse(r.participants) as string[]).includes(q.personId))
    )
  })
}

export const getSource = (id: string): Source | null => query([eq(sources.id, id)])[0] ?? null

/** 导入文件：内容相同的文件只存一份；已在资料库（未删除）中的相同文件跳过 */
export async function importPaths(
  paths: string[],
  categoryId?: string | null,
  init?: { aiExcluded?: boolean; onCreated?: (sourceId: string, assetId: string) => void }
): Promise<ImportResult> {
  const out: ImportResult = { imported: [], duplicates: 0 }
  const db = getDb()
  for (const p of paths) {
    if (!(await stat(p)).isFile()) continue
    const { row } = await importFile(p)
    const dup = db
      .select({ id: sources.id })
      .from(sources)
      .where(
        and(
          eq(sources.assetId, row.id),
          isNull(sources.deletedAt),
          eq(sources.space, 'library'),
          init?.aiExcluded ? eq(sources.aiExcluded, true) : undefined
        )
      )
      .get()
    if (dup) {
      out.duplicates++
      continue
    }
    const id = newId()
    const now = Date.now()
    const name = basename(p)
    db.transaction(() => {
      db.insert(sources)
        .values({
          id,
          title: name.replace(/\.[^.]+$/, ''),
          kind: EXT_KIND[extname(name).slice(1).toLowerCase()] ?? 'other',
          assetId: row.id,
          originalName: name,
          accessedAt: now,
          categoryId: categoryId ?? null,
          aiExcluded: init?.aiExcluded ?? false,
          createdAt: now,
          updatedAt: now,
          updatedBy: deviceId()
        })
        .run()
      init?.onCreated?.(id, row.id)
    })
    recordActivity('source_add')
    out.imported.push(getSource(id)!)
    if (canSegment(row.ext)) enqueueSegment(id)
    else if (isMedia(row.ext) && !init?.aiExcluded) {
      // 视频 / 音频：同名字幕优先；否则转写引擎已安装时自动转写
      const sub = findSidecarSubtitles(p)
      if (sub) {
        try {
          applySubtitleFile(id, sub)
        } catch (e) {
          log.warn('[sources] subtitles', e)
        }
      } else if (mossStatus().state === 'ready') enqueueMoss(id)
      else if (canAutoTranscribe()) enqueueTranscribe(id)
    }
  }
  return out
}

export async function importDialog(win: BrowserWindow | null, categoryId?: string | null): Promise<ImportResult> {
  const opts: Electron.OpenDialogOptions = { properties: ['openFile', 'multiSelections'] }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled) return { imported: [], duplicates: 0 }
  return importPaths(res.filePaths, categoryId)
}

/**
 * 内置浏览器：把正在看的网页存为资料（v0.6.0）。直接使用网页中已加载的内容（登录后才能看的页面也能存），
 * 同一网址复用已有资料；内容有变化时更新快照，重新分段（片段 ID 按内容沿用，批注与引用不失效）。
 */
export async function saveWebPage(input: { url: string; title: string; html: string }, valid?: () => boolean): Promise<Source> {
  const db = getDb()
  const ref = await importBytes('snapshot.html', 'text/html', new TextEncoder().encode(input.html))
  if (valid && !valid()) throw new Error('Page changed')
  const now = Date.now()
  const existing = db
    .select()
    .from(sources)
    .where(and(eq(sources.url, input.url), eq(sources.kind, 'web'), isNull(sources.deletedAt)))
    .get()
  if (existing) {
    const set: Partial<typeof sources.$inferInsert> = { accessedAt: now }
    if (existing.assetId !== ref.id) {
      set.assetId = ref.id
      set.updatedAt = now
      set.updatedBy = deviceId()
    }
    db.update(sources).set(set).where(eq(sources.id, existing.id)).run()
    if (existing.assetId !== ref.id) enqueueSegment(existing.id)
    return getSource(existing.id)!
  }
  const id = newId()
  db.insert(sources)
    .values({
      id,
      title: input.title.trim().slice(0, 500) || new URL(input.url).hostname,
      kind: 'web',
      url: input.url,
      assetId: ref.id,
      accessedAt: now,
      createdAt: now,
      updatedAt: now,
      updatedBy: deviceId()
    })
    .run()
  recordActivity('source_add')
  enqueueSegment(id)
  return getSource(id)!
}

export function addUrl(url: string, title?: string, categoryId?: string | null): Source {
  const parsed = new URL(url)
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) links are supported')
  const id = newId()
  const now = Date.now()
  getDb()
    .insert(sources)
    .values({
      id,
      title: title?.trim() || parsed.hostname + parsed.pathname.replace(/\/$/, ''),
      kind: 'web',
      url: parsed.toString(),
      accessedAt: now,
      categoryId: categoryId ?? null,
      createdAt: now,
      updatedAt: now,
      updatedBy: deviceId()
    })
    .run()
  recordActivity('source_add')
  enqueueFetch(id)
  return getSource(id)!
}

/** 下载的二进制资料走与本地文件相同的资产去重、分段和索引路径。 */
export async function importContent(name: string, mime: string, bytes: Uint8Array, init: { title: string; url?: string }): Promise<Source> {
  const asset = await importBytes(name, mime, bytes),
    db = getDb()
  const existing = db
    .select()
    .from(sources)
    .where(and(eq(sources.assetId, asset.id), isNull(sources.deletedAt), eq(sources.space, 'library')))
    .get()
  if (existing) return getSource(existing.id)!
  const id = newId(),
    now = Date.now()
  const ext = extname(name).slice(1).toLowerCase()
  db.insert(sources)
    .values({
      id,
      title: init.title.slice(0, 500),
      url: init.url ?? null,
      kind: EXT_KIND[ext] ?? 'other',
      originalName: name,
      assetId: asset.id,
      accessedAt: now,
      createdAt: now,
      updatedAt: now,
      updatedBy: deviceId()
    })
    .run()
  recordActivity('source_add')
  if (canSegment(ext)) enqueueSegment(id)
  return getSource(id)!
}

export function updateSource(id: string, patch: SourceUpdate): void {
  if (patch.aiExcluded === false && getSource(id)?.space === 'attachment')
    throw new Error('Archive this attachment before sharing it with AI')
  if (patch.aiExcluded !== undefined)
    getDb().update(recordings).set({ localOnly: patch.aiExcluded }).where(eq(recordings.sourceId, id)).run()
  getDb()
    .update(sources)
    .set({ ...patch, updatedAt: Date.now(), updatedBy: deviceId() })
    .where(eq(sources.id, id))
    .run()
  emit('sources:changed', { id })
}

function row(id: string) {
  const r = getDb()
    .select({ s: sources, a: assets })
    .from(sources)
    .leftJoin(assets, eq(sources.assetId, assets.id))
    .where(eq(sources.id, id))
    .get()
  if (!r) throw new Error(`Source not found: ${id}`)
  return r
}

export async function openSource(id: string): Promise<void> {
  const { s, a } = row(id)
  if (s.url) await shell.openExternal(s.url)
  else if (a) {
    const err = await shell.openPath(assetPath(a.id, a.ext))
    if (err) throw new Error(err)
  }
}

export function revealSource(id: string): void {
  const { a } = row(id)
  if (a) shell.showItemInFolder(assetPath(a.id, a.ext))
}

export function trashSource(id: string): void {
  getDb().update(sources).set({ deletedAt: Date.now(), updatedAt: Date.now(), updatedBy: deviceId() }).where(eq(sources.id, id)).run()
  emit('sources:changed', { id })
}

/** 永久删除：移除记录；素材文件仅在无其他引用时删除 */
export async function purgeSource(id: string): Promise<void> {
  const db = getDb()
  const recording = recordingForSource(id)
  if (recording) await purgeRecording(recording.id)
  db.delete(taggings)
    .where(and(eq(taggings.entityType, 'source'), eq(taggings.entityId, id)))
    .run()
  purgeSourceData(id)
  await collectGarbage()
}

/** 为视频 / 音频导入字幕（替换现有转写稿） */
export async function importSubtitlesDialog(win: BrowserWindow | null, sourceId: string): Promise<number | null> {
  const opts: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }] }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths[0]) return null
  return applySubtitleFile(sourceId, res.filePaths[0])
}

/** 删除来源的派生数据；调用方的生命周期事务可以一起回滚。 */
export function purgeSourceData(id: string): void {
  const db = getDb(),
    sqlite = getSqlite()
  db.transaction(() => {
    const pending = db
      .select()
      .from(jobs)
      .all()
      .filter((j) => {
        try {
          return (JSON.parse(j.payload) as { sourceId?: string }).sourceId === id
        } catch {
          return false
        }
      })
    for (const job of pending) cancelJob(job.id)
    const vectors = db
      .select({ rowid: chunks.rowid })
      .from(chunks)
      .where(and(eq(chunks.parentType, 'source'), eq(chunks.parentId, id)))
      .all()
    for (const v of vectors) sqlite.prepare('DELETE FROM vec_chunks WHERE rowid = ?').run(BigInt(v.rowid))
    db.delete(chunks)
      .where(and(eq(chunks.parentType, 'source'), eq(chunks.parentId, id)))
      .run()
    db.delete(conversationAttachments).where(eq(conversationAttachments.sourceId, id)).run()
    db.delete(sourcePages).where(eq(sourcePages.sourceId, id)).run()
    db.delete(annotations)
      .where(and(eq(annotations.targetType, 'source'), eq(annotations.targetId, id)))
      .run()
    db.delete(links)
      .where(or(and(eq(links.fromType, 'source'), eq(links.fromId, id)), and(eq(links.toType, 'source'), eq(links.toId, id))))
      .run()
    db.delete(sources).where(eq(sources.id, id)).run()
    deleteSegments(id)
  })
}
