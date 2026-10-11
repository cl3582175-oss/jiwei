import { sandboxResponse } from './sandbox'
import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { Readable } from 'stream'
import { copyFile, mkdir, rename, rm, stat, writeFile } from 'fs/promises'
import { extname, join } from 'path'
import { net, protocol } from 'electron'
import { recordingAudio } from './recording'
import { recordingPlainSize, recordingStream, recordingKey } from './recordingFiles'
import { pathToFileURL } from 'url'
import { eq, inArray, notInArray } from 'drizzle-orm'
import log from 'electron-log/main'
import { assetsDir, dataDir, getDb } from '../db'
import { assets, noteAssets, sources, sourceSegments, inboxItems, mistakes } from '../db/schema'
import type { AssetRef } from '@shared/types'

// 内容寻址素材仓库：文件以 sha256 命名，相同内容只存一份。
// 路径：assets/ab/cd/<sha256>.<ext>

export const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  m4v: 'video/mp4',
  avi: 'video/x-msvideo',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  md: 'text/markdown',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  csv: 'text/csv',
  json: 'application/json',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}

const safeExt = (name: string): string =>
  extname(name)
    .slice(1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 10) || 'bin'

export function assetPath(id: string, ext: string): string {
  return join(assetsDir(), id.slice(0, 2), id.slice(2, 4), `${id}.${ext}`)
}

/** 每日播客 AI 语音目录：<数据目录>/podcast/<日期>/；只保留当天 */
export const podcastDir = (date?: string): string => (date ? join(dataDir(), 'podcast', date) : join(dataDir(), 'podcast'))

export const assetUrl = (id: string, ext: string): string => `jiwei://asset/${id}.${ext}`

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

function register(id: string, ext: string, size: number): { row: typeof assets.$inferSelect; existed: boolean } {
  const db = getDb()
  const existing = db.select().from(assets).where(eq(assets.id, id)).get()
  if (existing) return { row: existing, existed: true }
  const row = { id, ext, mime: MIME[ext] ?? null, size, createdAt: Date.now() }
  db.insert(assets).values(row).run()
  return { row, existed: false }
}

/** 导入磁盘文件（流式计算哈希，适合大视频） */
export async function importFile(path: string): Promise<{ row: typeof assets.$inferSelect; existed: boolean }> {
  const ext = safeExt(path)
  const id = await sha256File(path)
  const dest = assetPath(id, ext)
  const s = await stat(path)
  const exists = await stat(dest).then(
    () => true,
    () => false
  )
  if (!exists) {
    await mkdir(join(dest, '..'), { recursive: true })
    const tmp = `${dest}.tmp-${process.pid}`
    await copyFile(path, tmp)
    await rename(tmp, dest)
  }
  return register(id, ext, s.size)
}

/** 导入内存中的字节（粘贴 / 拖入编辑器的图片） */
export async function importBytes(name: string, mime: string, bytes: Uint8Array): Promise<AssetRef> {
  const extFromMime = Object.entries(MIME).find(([, m]) => m === mime)?.[0]
  const ext = safeExt(name) !== 'bin' ? safeExt(name) : (extFromMime ?? 'bin')
  const id = createHash('sha256').update(bytes).digest('hex')
  const dest = assetPath(id, ext)
  if (
    !(await stat(dest).then(
      () => true,
      () => false
    ))
  ) {
    await mkdir(join(dest, '..'), { recursive: true })
    await writeFile(dest, bytes)
  }
  const { row } = register(id, ext, bytes.byteLength)
  return { id, url: assetUrl(id, ext), mime: row.mime, size: row.size }
}

/** 删除不再被任何资料或笔记引用的素材文件 */
export async function collectGarbage(): Promise<number> {
  const db = getDb()
  const used = new Set<string>([
    ...db.select({ assetId: mistakes.assetId, cropAssetId: mistakes.cropAssetId }).from(mistakes).all().flatMap((r) => [r.assetId, r.cropAssetId].filter((id): id is string => !!id)),
    ...db
      .select({ id: inboxItems.assetId })
      .from(inboxItems)
      .all()
      .flatMap((r) => (r.id ? [r.id] : [])),
    ...db
      .select({ id: sources.assetId })
      .from(sources)
      .all()
      .map((r) => r.id)
      .filter((x): x is string => !!x),
    ...db
      .select({ id: noteAssets.assetId })
      .from(noteAssets)
      .all()
      .map((r) => r.id)
  ])
  // 幻灯片资产由资料分段引用，没有 source.assetId；清理时必须计入可达素材。
  for (const row of db.select({ locator: sourceSegments.locator }).from(sourceSegments).all()) {
    try {
      const locator = JSON.parse(row.locator) as { image?: unknown }
      if (typeof locator.image === 'string') used.add(locator.image)
    } catch {
      /* 旧定位数据不能影响其他素材的清理 */
    }
  }
  const orphans = used.size
    ? db
        .select()
        .from(assets)
        .where(notInArray(assets.id, [...used]))
        .all()
    : db.select().from(assets).all()
  for (const a of orphans) await rm(assetPath(a.id, a.ext), { force: true })
  if (orphans.length)
    db.delete(assets)
      .where(
        inArray(
          assets.id,
          orphans.map((a) => a.id)
        )
      )
      .run()
  if (orphans.length) log.info('[assets] removed', orphans.length, 'orphan files')
  return orphans.length
}

/** 必须在 app ready 之前调用 */
export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'jiwei', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
  ])
}

/** jiwei://asset/<sha256>.<ext> → 素材文件（支持 Range，便于音视频拖动进度） */
export function registerProtocol(): void {
  protocol.handle('jiwei', async (req) => {
    const url = new URL(req.url)
    if (url.hostname === 'sandbox') return sandboxResponse(url.pathname.slice(1))
    if (url.hostname === 'recording') {
      const id = url.pathname.slice(1)
      if (!/^[0-9a-f-]{36}$/.test(id)) return new Response('Bad request', { status: 400 })
      const file = recordingAudio(id)
      if (!file) return new Response('Not found', { status: 404 })
      if (file.endsWith('.enc')) { try { recordingKey() } catch { return new Response('请先输入恢复码解锁录音', { status: 423 }) } }
      const size = await recordingPlainSize(file)
      const headers = new Headers({
        'Content-Type': 'audio/webm',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'bytes'
      })
      let start = 0,
        end = size - 1
      const range = req.headers.get('range')
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range)
        if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
        start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
        end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size)
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
        headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
      }
      headers.set('Content-Length', String(end - start + 1))
      const stream = file.endsWith('.enc') ? Readable.from(await recordingStream(file, start, end)) : createReadStream(file, { start, end })
      const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>
      return new Response(body, { status: range ? 206 : 200, headers })
    }
    if (url.hostname === 'podcast') {
      // jiwei://podcast/<日期>/<序号>.<wav|mp3>：每日播客的 AI 语音
      const m = /^\/(\d{4}-\d{2}-\d{2}|preview)\/([0-9a-z]{3,12})\.(wav|mp3)$/.exec(url.pathname)
      if (!m) return new Response('Bad request', { status: 400 })
      const res = await net.fetch(pathToFileURL(join(podcastDir(m[1]), `${m[2]}.${m[3]}`)).toString(), { headers: req.headers })
      const headers = new Headers(res.headers)
      headers.set('Content-Type', MIME[m[3]])
      headers.set('Cache-Control', 'no-store')
      headers.set('Access-Control-Allow-Origin', '*')
      return new Response(res.body, { status: res.status, headers })
    }
    if (url.hostname !== 'asset') return new Response('Not found', { status: 404 })
    const m = /^\/([0-9a-f]{64})\.([a-z0-9]{1,10})$/.exec(url.pathname)
    if (!m) return new Response('Bad request', { status: 400 })
    const file = assetPath(m[1], m[2])
    const res = await net.fetch(pathToFileURL(file).toString(), { headers: req.headers })
    const headers = new Headers(res.headers)
    if (MIME[m[2]]) headers.set('Content-Type', MIME[m[2]])
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    // 渲染进程（pdf.js 等）以 fetch 读取素材
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(res.body, { status: res.status, headers })
  })
}
