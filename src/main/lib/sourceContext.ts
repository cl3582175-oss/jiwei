import type { SearchHit, Segment, Source } from '@shared/types'

export type ContextSource = Pick<Source, 'id' | 'title' | 'accessedAt' | 'publishedAt' | 'aiExcluded' | 'deletedAt'> & {
  segments: Segment[]
}

/** 每份资料共享预算，保留真实分段身份；截断处明确标记，模型可继续用 source_read 读取。 */
export function sourceContextHits(sources: readonly ContextSource[], budget = 12_000): SearchHit[] {
  if (budget <= 0 || !Number.isFinite(budget)) return []
  const readable = sources
    .filter(
      (source, index) => !source.aiExcluded && source.deletedAt === null && sources.findIndex((item) => item.id === source.id) === index
    )
    .slice(0, 8)
  const perSource = Math.min(6000, Math.floor(budget / Math.max(1, readable.length)))
  const hits: SearchHit[] = []
  for (const source of readable) {
    let remaining = perSource
    const segments = source.segments.filter((segment) => segment.sourceId === source.id && segment.text.trim()).slice(0, 12)
    for (const segment of segments) {
      if (remaining <= 0) break
      const text = segment.text.length <= remaining ? segment.text : segment.text.slice(0, remaining - 1) + '…'
      remaining -= text.length
      hits.push({
        parentType: 'source',
        parentId: source.id,
        ownerId: segment.id,
        title: source.title,
        text,
        locator: typeof segment.locator.value === 'string' ? segment.locator.value : null,
        score: 1,
        learnedAt: source.publishedAt ?? source.accessedAt,
        updatedAt: source.accessedAt,
        status: null,
        origin: null
      })
    }
  }
  return hits
}
