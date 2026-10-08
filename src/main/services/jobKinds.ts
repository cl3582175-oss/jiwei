import { eq } from 'drizzle-orm'
import { getDb } from '../db'
import { assets, sources } from '../db/schema'
import { assetPath } from './assets'
import { registerJobKind, enqueue } from './jobs'
import { replaceSegments } from './segments'
import type { TextSegment } from '../lib/segment'

// 后台任务类型注册。v0.2 起在这里加入：PDF / EPUB / 网页解析、音视频转写、向量化。

const TEXT_EXTS = new Set(['txt', 'md', 'markdown'])

/** 资料是否支持当前版本的分段解析 */
export function canSegment(ext: string): boolean {
  return TEXT_EXTS.has(ext)
}

export function enqueueSegment(sourceId: string): void {
  enqueue('source.segment', { sourceId }, { dedupeKey: `segment:${sourceId}` })
}

export function registerJobKinds(): void {
  registerJobKind<{ sourceId: string }>('source.segment', {
    title: ({ sourceId }) => {
      const s = getDb().select({ title: sources.title }).from(sources).where(eq(sources.id, sourceId)).get()
      return `解析资料：${s?.title ?? sourceId}`
    },
    async run({ sourceId }, ctx) {
      const row = getDb().select({ s: sources, a: assets }).from(sources).leftJoin(assets, eq(sources.assetId, assets.id)).where(eq(sources.id, sourceId)).get()
      if (!row?.a) return { skipped: 'no file' }
      if (!canSegment(row.a.ext)) return { skipped: `unsupported: ${row.a.ext}` }
      const segs = await ctx.worker<TextSegment[]>('segmentTextFile', { path: assetPath(row.a.id, row.a.ext), ext: row.a.ext })
      if (ctx.isCanceled()) return
      return { segments: replaceSegments(sourceId, segs) }
    }
  })
}
