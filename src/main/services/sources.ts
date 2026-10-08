import { randomUUID } from 'crypto'
import { basename, extname, join } from 'path'
import { copyFile, mkdir, rm, stat } from 'fs/promises'
import { BrowserWindow, dialog, shell } from 'electron'
import { and, desc, eq, isNull, like, or, type SQL } from 'drizzle-orm'
import { getDb, libraryDir } from '../db'
import { sources } from '../db/schema'
import { recordActivity } from './stats'
import type { Source, SourceKind, SourceQuery } from '@shared/types'

type Row = typeof sources.$inferSelect

const EXT_KIND: Record<string, SourceKind> = {
  pdf: 'pdf',
  epub: 'book', mobi: 'book', azw3: 'book',
  mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', avi: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', flac: 'audio', ogg: 'audio', aac: 'audio',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', heic: 'image',
  doc: 'document', docx: 'document', txt: 'document', md: 'document', ppt: 'document', pptx: 'document',
  xls: 'document', xlsx: 'document', csv: 'document', html: 'document', htm: 'document'
}

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf', epub: 'application/epub+zip', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', md: 'text/markdown', txt: 'text/plain'
}

function toSource(r: Row): Source {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind as SourceKind,
    originalName: r.originalName,
    mime: r.mime,
    size: r.size,
    url: r.url,
    categoryId: r.categoryId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt
  }
}

export function listSources(query: SourceQuery): Source[] {
  const conds: SQL[] = [isNull(sources.deletedAt)]
  if (query.categoryId !== undefined) {
    conds.push(query.categoryId === null ? isNull(sources.categoryId) : eq(sources.categoryId, query.categoryId))
  }
  if (query.kind) conds.push(eq(sources.kind, query.kind))
  if (query.search?.trim()) {
    const pat = `%${query.search.trim()}%`
    conds.push(or(like(sources.title, pat), like(sources.originalName, pat), like(sources.url, pat))!)
  }
  return getDb().select().from(sources).where(and(...conds)).orderBy(desc(sources.createdAt)).all().map(toSource)
}

/** 复制文件到资料库（按 年/月 分目录），原文件保持不动 */
export async function importPaths(paths: string[], categoryId?: string | null): Promise<Source[]> {
  const out: Source[] = []
  const now = new Date()
  const sub = join(String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'))
  await mkdir(join(libraryDir(), sub), { recursive: true })
  for (const p of paths) {
    const st = await stat(p)
    if (!st.isFile()) continue
    const id = randomUUID()
    const name = basename(p)
    const ext = extname(name).slice(1).toLowerCase()
    const rel = join(sub, `${id}${ext ? '.' + ext : ''}`)
    await copyFile(p, join(libraryDir(), rel))
    const ts = Date.now()
    getDb()
      .insert(sources)
      .values({
        id,
        title: name.replace(/\.[^.]+$/, ''),
        kind: EXT_KIND[ext] ?? 'other',
        filePath: rel,
        originalName: name,
        mime: EXT_MIME[ext] ?? null,
        size: st.size,
        categoryId: categoryId ?? null,
        createdAt: ts,
        updatedAt: ts
      })
      .run()
    recordActivity('source_add')
    out.push(toSource(getDb().select().from(sources).where(eq(sources.id, id)).get()!))
  }
  return out
}

export async function importDialog(win: BrowserWindow | null, categoryId?: string | null): Promise<Source[]> {
  const opts: Electron.OpenDialogOptions = { properties: ['openFile', 'multiSelections'] }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled) return []
  return importPaths(res.filePaths, categoryId)
}

export function addUrl(url: string, title?: string, categoryId?: string | null): Source {
  const parsed = new URL(url)
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http(s) links are supported')
  const id = randomUUID()
  const ts = Date.now()
  getDb()
    .insert(sources)
    .values({
      id,
      title: title?.trim() || parsed.hostname + parsed.pathname.replace(/\/$/, ''),
      kind: 'web',
      url: parsed.toString(),
      categoryId: categoryId ?? null,
      createdAt: ts,
      updatedAt: ts
    })
    .run()
  recordActivity('source_add')
  return toSource(getDb().select().from(sources).where(eq(sources.id, id)).get()!)
}

export function updateSource(id: string, patch: { title?: string; categoryId?: string | null }): void {
  getDb()
    .update(sources)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(sources.id, id))
    .run()
}

function getRow(id: string): Row {
  const r = getDb().select().from(sources).where(eq(sources.id, id)).get()
  if (!r) throw new Error(`Source not found: ${id}`)
  return r
}

export async function openSource(id: string): Promise<void> {
  const r = getRow(id)
  if (r.url) await shell.openExternal(r.url)
  else if (r.filePath) {
    const err = await shell.openPath(join(libraryDir(), r.filePath))
    if (err) throw new Error(err)
  }
}

export function revealSource(id: string): void {
  const r = getRow(id)
  if (r.filePath) shell.showItemInFolder(join(libraryDir(), r.filePath))
}

export function trashSource(id: string): void {
  getDb().update(sources).set({ deletedAt: Date.now() }).where(eq(sources.id, id)).run()
}

/** 永久删除：移除数据库记录与资料库中的文件 */
export async function purgeSource(id: string): Promise<void> {
  const r = getDb().select().from(sources).where(eq(sources.id, id)).get()
  if (!r) return
  if (r.filePath) await rm(join(libraryDir(), r.filePath), { force: true })
  getDb().delete(sources).where(eq(sources.id, id)).run()
}
