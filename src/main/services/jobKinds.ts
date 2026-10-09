import { net } from 'electron'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { getDb } from '../db'
import { assets, sources } from '../db/schema'
import { assetPath, importBytes } from './assets'
import { registerJobKind, enqueue } from './jobs'
import { replaceSegments, type SegmentInput } from './segments'
import { requestIndex } from './ai/indexer'
import { deviceId } from './device'
import type { TextSegment } from '../lib/segment'
import { applyRecognized, IMAGE_EXTS, maybeAutoRecognize, recordPages } from './recognize'

// 后台任务类型注册：资料解析、网页抓取。解析完成后触发知识库索引更新。

const PARSERS: Record<string, string> = {
  txt: 'segmentTextFile',
  md: 'segmentTextFile',
  markdown: 'segmentTextFile',
  pdf: 'parsePdf',
  docx: 'parseDocx',
  epub: 'parseEpub',
  html: 'parseHtml',
  htm: 'parseHtml'
}

/** 资料是否支持当前版本的解析（图片资料由文档识别生成文字） */
export function canSegment(ext: string): boolean {
  return ext in PARSERS || IMAGE_EXTS.has(ext)
}

export function enqueueSegment(sourceId: string): void {
  enqueue('source.segment', { sourceId }, { dedupeKey: `segment:${sourceId}` })
}

export function enqueueFetch(sourceId: string): void {
  enqueue('source.fetch', { sourceId }, { dedupeKey: `fetch:${sourceId}` })
}

/** 补救：v0.5.1.1 之前 PDF 解析全部失败，启动时为没有分段的 PDF 重新排队 */
export function resegmentEmptyPdfs(): number {
  const rows = getDb()
    .select({ id: sources.id })
    .from(sources)
    .innerJoin(assets, eq(sources.assetId, assets.id))
    .where(and(isNull(sources.deletedAt), eq(assets.ext, 'pdf'), sql`NOT EXISTS (SELECT 1 FROM source_segments g WHERE g.source_id = ${sources.id})`))
    .all()
  for (const r of rows) enqueueSegment(r.id)
  return rows.length
}

const sourceTitle = (id: string): string =>
  getDb().select({ title: sources.title }).from(sources).where(eq(sources.id, id)).get()?.title ?? id

export function registerJobKinds(): void {
  registerJobKind<{ sourceId: string }>('source.segment', {
    title: ({ sourceId }) => `解析资料：${sourceTitle(sourceId)}`,
    async run({ sourceId }, ctx) {
      const row = getDb()
        .select({ s: sources, a: assets })
        .from(sources)
        .leftJoin(assets, eq(sources.assetId, assets.id))
        .where(eq(sources.id, sourceId))
        .get()
      if (!row?.a) return { skipped: 'no file' }
      // 图片资料：整张图按“扫描页”识别
      if (IMAGE_EXTS.has(row.a.ext)) {
        recordPages(sourceId, [{ page: 1, need: 'scan' }])
        applyRecognized(sourceId)
        maybeAutoRecognize(sourceId)
        return { image: true }
      }
      const task = PARSERS[row.a.ext]
      if (!task) return { skipped: `unsupported: ${row.a.ext}` }
      const result = await ctx.worker<TextSegment[] | SegmentInput[] | { title: string; segments: SegmentInput[] }>(task, {
        path: assetPath(row.a.id, row.a.ext),
        ext: row.a.ext
      })
      if (ctx.isCanceled()) return
      const segs = Array.isArray(result) ? result : result.segments
      const n = replaceSegments(sourceId, segs as SegmentInput[])
      // PDF：登记需要识别的页，并入已有的识别结果（重新解析不必重算），按设置自动识别
      if (!Array.isArray(result) && 'pages' in result) {
        recordPages(sourceId, (result as { pages: { page: number; need: 'scan' | 'table' | 'figure' }[] }).pages)
        applyRecognized(sourceId)
        maybeAutoRecognize(sourceId)
      }
      requestIndex()
      return { segments: n }
    }
  })

  // 网页：抓取并保存快照（防止原网页失效），再提取正文
  registerJobKind<{ sourceId: string }>('source.fetch', {
    title: ({ sourceId }) => `抓取网页：${sourceTitle(sourceId)}`,
    async run({ sourceId }, ctx) {
      const s = getDb().select().from(sources).where(eq(sources.id, sourceId)).get()
      if (!s?.url) return { skipped: 'no url' }
      const res = await net.fetch(s.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Jiwei)' }, signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const type = res.headers.get('content-type') ?? ''
      if (!/html|text/.test(type)) throw new Error(`不支持的网页类型：${type}`)
      const html = await res.text()
      const ref = await importBytes('snapshot.html', 'text/html', new TextEncoder().encode(html))
      getDb().update(sources).set({ assetId: ref.id, updatedAt: Date.now(), updatedBy: deviceId() }).where(eq(sources.id, sourceId)).run()
      const parsed = await ctx.worker<{ title: string; segments: SegmentInput[] }>('parseHtml', { path: assetPath(ref.id, 'html') })
      // 用户未自定义标题（仍为网址形式）时，采用网页标题
      if (parsed.title && s.title.includes(new URL(s.url).hostname)) {
        getDb()
          .update(sources)
          .set({ title: parsed.title.slice(0, 200) })
          .where(eq(sources.id, sourceId))
          .run()
      }
      const n = replaceSegments(sourceId, parsed.segments)
      requestIndex()
      return { segments: n }
    }
  })
}
