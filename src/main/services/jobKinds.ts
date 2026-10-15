import { canUpgradeSource } from './sourceUpgrade'
import { FORMATS, CURRENT_PARSE_VERSION } from '@shared/formats'
import { externalFetch } from './externalFetch'
import { registerIcsJobs } from './plan/ics'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { getDb } from '../db'
import { assets, sources } from '../db/schema'
import { assetPath, importBytes } from './assets'
import { registerJobKind, enqueue } from './jobs'
import { listSegments, replaceSegments, type SegmentInput } from './segments'
import { requestIndex } from './ai/indexer'
import { deviceId } from './device'
import type { TextSegment } from '../lib/segment'
import { applyRecognized, IMAGE_EXTS, maybeAutoRecognize, recordPages } from './recognize'
import { getSettings } from './settings'

// 后台任务类型注册：资料解析、网页抓取。解析完成后触发知识库索引更新。

export const PARSERS: Record<string, string> = Object.fromEntries(
  Object.entries(FORMATS).flatMap(([ext, info]) => (info.parser ? [[ext, info.parser]] : []))
)

/** 资料是否支持当前版本的解析（图片资料由文档识别生成文字） */
export function canSegment(ext: string): boolean {
  return ext in PARSERS || IMAGE_EXTS.has(ext)
}

export { enqueueSegment } from './segmentJobs'
import { enqueueSegment } from './segmentJobs'

export function enqueueFetch(sourceId: string): void {
  enqueue('source.fetch', { sourceId }, { dedupeKey: `fetch:${sourceId}` })
}

/** 补救：v0.5.1.1 之前 PDF 解析全部失败，启动时为没有分段的 PDF 重新排队 */
export function resegmentEmptyPdfs(): number {
  const rows = getDb()
    .select({ id: sources.id })
    .from(sources)
    .innerJoin(assets, eq(sources.assetId, assets.id))
    .where(
      and(
        isNull(sources.deletedAt),
        eq(assets.ext, 'pdf'),
        sql`NOT EXISTS (SELECT 1 FROM source_segments g WHERE g.source_id = ${sources.id})`
      )
    )
    .all()
  for (const r of rows) enqueueSegment(r.id)
  return rows.length
}

const sourceTitle = (id: string): string => {
  const s = getDb().select({ title: sources.title, space: sources.space }).from(sources).where(eq(sources.id, id)).get()
  return s?.space === 'attachment' ? '对话附件' : (s?.title ?? id)
}

export function registerJobKinds(): void {
  registerIcsJobs()
  registerJobKind<{ sourceId: string; upgrade?: boolean }>('source.segment', {
    title: ({ sourceId }) => `解析资料：${sourceTitle(sourceId)}`,
    async run({ sourceId, upgrade }, ctx) {
      if (upgrade && !getSettings().retrieval.autoUpgrade) return { skipped: 'upgrade paused' }
      if (upgrade && !canUpgradeSource(sourceId)) return { skipped: 'ineligible upgrade' }
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
        if (!upgrade) maybeAutoRecognize(sourceId)
        getDb().update(sources).set({ parseVersion: CURRENT_PARSE_VERSION }).where(eq(sources.id, sourceId)).run()
        return { image: true }
      }
      const task = PARSERS[row.a.ext]
      if (!task) return { skipped: `unsupported: ${row.a.ext}` }
      const result = await ctx.worker<TextSegment[] | SegmentInput[] | { title: string; segments: SegmentInput[] }>(task, {
        path: assetPath(row.a.id, row.a.ext),
        ext: row.a.ext,
        name: row.s.originalName ?? row.s.title
      })
      if (ctx.isCanceled()) return
      if (upgrade && !canUpgradeSource(sourceId)) return { skipped: 'ineligible upgrade' }
      const segs = Array.isArray(result) ? result : result.segments
      // 网页解析可能晚于字幕与截图完成；正文刷新只能替换正文，不能清空课程材料。
      // 缓存并入之前先保留旧 OCR 身份，随后重切才能为它建立别名与改写批注。
      const course = listSegments(sourceId).filter(
        (s) => s.kind === 'transcript' || (s.kind === 'slide' && row.s.url) || s.kind.startsWith('ocr:')
      )
      const n = replaceSegments(sourceId, [...(segs as SegmentInput[]), ...course])
      // PDF：登记需要识别的页，并入已有的识别结果（重新解析不必重算），按设置自动识别
      if (!Array.isArray(result) && 'pages' in result) {
        recordPages(sourceId, (result as { pages: { page: number; need: 'scan' | 'table' | 'figure' }[] }).pages)
        applyRecognized(sourceId)
        if (!upgrade) maybeAutoRecognize(sourceId)
      }
      requestIndex()
      getDb().update(sources).set({ parseVersion: CURRENT_PARSE_VERSION }).where(eq(sources.id, sourceId)).run()
      return { segments: n }
    }
  })

  // 网页：抓取并保存快照（防止原网页失效），再提取正文
  registerJobKind<{ sourceId: string }>('source.fetch', {
    title: ({ sourceId }) => `抓取网页：${sourceTitle(sourceId)}`,
    async run({ sourceId }, ctx) {
      const s = getDb().select().from(sources).where(eq(sources.id, sourceId)).get()
      if (!s?.url) return { skipped: 'no url' }
      const res = await externalFetch(s.url, { signal: ctx.signal, maxBytes: 8 * 1024 * 1024 })
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
      const type = res.headers.get('content-type') ?? ''
      if (!/html|text/.test(type)) throw new Error(`不支持的网页类型：${type}`)
      const html = res.text
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
      const course = listSegments(sourceId).filter((segment) => segment.kind === 'transcript' || segment.kind === 'slide')
      const n = replaceSegments(sourceId, [...parsed.segments, ...course])
      requestIndex()
      getDb().update(sources).set({ parseVersion: CURRENT_PARSE_VERSION }).where(eq(sources.id, sourceId)).run()
      return { segments: n }
    }
  })
}
