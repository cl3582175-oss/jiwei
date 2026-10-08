import { basename, extname } from 'path'
import { stat } from 'fs/promises'
import { BrowserWindow, dialog, shell } from 'electron'
import { and, desc, eq, inArray, isNull, like, or, type SQL } from 'drizzle-orm'
import { getDb } from '../db'
import { assets, sources, taggings } from '../db/schema'
import { newId } from '../lib/ids'
import { deviceId } from './device'
import { recordActivity } from './stats'
import { deletedCategoryIds, descendantIds } from './categories'
import { entitiesWithTag, tagIdsFor } from './tags'
import { assetPath, assetUrl, collectGarbage, importFile } from './assets'
import { canSegment, enqueueSegment } from './jobKinds'
import { deleteSegments } from './segments'
import type { ImportResult, Source, SourceKind, SourceQuery, SourceUpdate } from '@shared/types'

const EXT_KIND: Record<string, SourceKind> = {
  pdf: 'pdf',
  epub: 'book', mobi: 'book', azw3: 'book',
  mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', avi: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', flac: 'audio', ogg: 'audio', aac: 'audio',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', heic: 'image', avif: 'image',
  doc: 'document', docx: 'document', txt: 'document', md: 'document', ppt: 'document', pptx: 'document',
  xls: 'document', xlsx: 'document', csv: 'document', html: 'document', htm: 'document'
}

function query(conds: SQL[]): Source[] {
  const rows = getDb()
    .select({ s: sources, a: assets })
    .from(sources)
    .leftJoin(assets, eq(sources.assetId, assets.id))
    .where(and(...conds))
    .orderBy(desc(sources.createdAt))
    .all()
  const tagMap = tagIdsFor('source', rows.map((r) => r.s.id))
  return rows.map(({ s, a }) => ({
    id: s.id,
    title: s.title,
    kind: s.kind as SourceKind,
    assetUrl: a ? assetUrl(a.id, a.ext) : null,
    originalName: s.originalName,
    mime: a?.mime ?? null,
    size: a?.size ?? 0,
    url: s.url,
    author: s.author,
    publishedAt: s.publishedAt,
    accessedAt: s.accessedAt,
    categoryId: s.categoryId,
    aiExcluded: s.aiExcluded,
    tagIds: tagMap.get(s.id) ?? [],
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    deletedAt: s.deletedAt
  }))
}

export function listSources(q: SourceQuery): Source[] {
  const conds: SQL[] = [isNull(sources.deletedAt)]
  if (q.categoryId !== undefined) {
    if (q.categoryId === null) {
      const dead = deletedCategoryIds()
      conds.push(dead.length ? or(isNull(sources.categoryId), inArray(sources.categoryId, dead))! : isNull(sources.categoryId))
    } else {
      conds.push(inArray(sources.categoryId, q.includeDescendants ? descendantIds(q.categoryId) : [q.categoryId]))
    }
  }
  if (q.kind) conds.push(eq(sources.kind, q.kind))
  if (q.tagId) conds.push(inArray(sources.id, entitiesWithTag('source', q.tagId)))
  if (q.search?.trim()) {
    const pat = `%${q.search.trim()}%`
    conds.push(or(like(sources.title, pat), like(sources.originalName, pat), like(sources.url, pat), like(sources.author, pat))!)
  }
  return query(conds)
}

export const getSource = (id: string): Source | null => query([eq(sources.id, id)])[0] ?? null

/** 导入文件：内容相同的文件只存一份；已在资料库（未删除）中的相同文件跳过 */
export async function importPaths(paths: string[], categoryId?: string | null): Promise<ImportResult> {
  const out: ImportResult = { imported: [], duplicates: 0 }
  const db = getDb()
  for (const p of paths) {
    if (!(await stat(p)).isFile()) continue
    const { row } = await importFile(p)
    const dup = db.select({ id: sources.id }).from(sources).where(and(eq(sources.assetId, row.id), isNull(sources.deletedAt))).get()
    if (dup) {
      out.duplicates++
      continue
    }
    const id = newId()
    const now = Date.now()
    const name = basename(p)
    db.insert(sources)
      .values({
        id,
        title: name.replace(/\.[^.]+$/, ''),
        kind: EXT_KIND[extname(name).slice(1).toLowerCase()] ?? 'other',
        assetId: row.id,
        originalName: name,
        accessedAt: now,
        categoryId: categoryId ?? null,
        createdAt: now,
        updatedAt: now,
        updatedBy: deviceId()
      })
      .run()
    recordActivity('source_add')
    out.imported.push(getSource(id)!)
    if (canSegment(row.ext)) enqueueSegment(id)
  }
  return out
}

export async function importDialog(win: BrowserWindow | null, categoryId?: string | null): Promise<ImportResult> {
  const opts: Electron.OpenDialogOptions = { properties: ['openFile', 'multiSelections'] }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled) return { imported: [], duplicates: 0 }
  return importPaths(res.filePaths, categoryId)
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
  return getSource(id)!
}

export function updateSource(id: string, patch: SourceUpdate): void {
  getDb()
    .update(sources)
    .set({ ...patch, updatedAt: Date.now(), updatedBy: deviceId() })
    .where(eq(sources.id, id))
    .run()
}

function row(id: string) {
  const r = getDb().select({ s: sources, a: assets }).from(sources).leftJoin(assets, eq(sources.assetId, assets.id)).where(eq(sources.id, id)).get()
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
}

/** 永久删除：移除记录；素材文件仅在无其他引用时删除 */
export async function purgeSource(id: string): Promise<void> {
  const db = getDb()
  db.delete(taggings).where(and(eq(taggings.entityType, 'source'), eq(taggings.entityId, id))).run()
  db.delete(sources).where(eq(sources.id, id)).run()
  deleteSegments(id)
  await collectGarbage()
}
