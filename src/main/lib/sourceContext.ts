import type { SearchHit, Segment, Source } from '@shared/types'

export type ContextSource = Pick<Source, 'id' | 'title' | 'accessedAt' | 'publishedAt' | 'aiExcluded' | 'deletedAt'> & {
  segments: Segment[]
}

export function estimateTokens(text: string): number {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0
  return han * 0.7 + (text.length - han) / 4
}
/** E5 比较后由后续版本裁定默认值；所有全文路径共用此处。 */
export const FULL_SOURCE_MAX_TOKENS = 60_000
export const FULL_SOURCE_CONTEXT_FRACTION = 0.4
export const sourceTextBudget = (contextLength: number, ceiling = FULL_SOURCE_MAX_TOKENS): number =>
  Math.max(0, Math.min(ceiling, FULL_SOURCE_CONTEXT_FRACTION * contextLength))

/** 保留 v0.14.4 的单个短附件全文；明确的小窗口/服务商拒绝后的重试遵守真实预算。 */
export const shortAttachmentBudget = (contextLength: number, constrained: boolean, ceiling = FULL_SOURCE_MAX_TOKENS): number =>
  constrained ? sourceTextBudget(contextLength, ceiling) : Math.max(8400, sourceTextBudget(contextLength, ceiling))

export function fullSourceFits(sources: readonly ContextSource[], contextLength: number, ceiling = FULL_SOURCE_MAX_TOKENS): boolean {
  if (!sources.length || sources.length > 5 || contextLength <= 0) return false
  if (sources.some((s) => s.aiExcluded || s.deletedAt !== null || !s.segments.some((g) => g.sourceId === s.id && g.text.trim())))
    return false
  const tokens = sources.reduce(
    (sum, s) => sum + s.segments.filter((g) => g.sourceId === s.id).reduce((n, g) => n + estimateTokens(g.text), 0),
    0
  )
  return tokens <= sourceTextBudget(contextLength, ceiling)
}

/** 每份资料共享预算，保留真实分段身份；截断处明确标记，模型可继续用 source_read 读取。 */
export function sourceContextHits(sources: readonly ContextSource[], budget = 12_000, opts: { full?: boolean } = {}): SearchHit[] {
  if (budget <= 0 || !Number.isFinite(budget)) return []
  const readable = sources
    .filter(
      (source, index) => !source.aiExcluded && source.deletedAt === null && sources.findIndex((item) => item.id === source.id) === index
    )
    .slice(0, opts.full ? 5 : 8)
  if (
    opts.full &&
    readable.reduce((sum, s) => sum + s.segments.filter((g) => g.sourceId === s.id).reduce((n, g) => n + g.text.length, 0), 0) > budget
  )
    return []
  const perSource = opts.full ? budget : Math.min(6000, Math.floor(budget / Math.max(1, readable.length)))
  const hits: SearchHit[] = []
  for (const source of readable) {
    let remaining = perSource
    const all = source.segments.filter((segment) => segment.sourceId === source.id && segment.text.trim())
    const segments = opts.full ? all : all.slice(0, 12)
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
        heading: segment.heading,
        ...(typeof segment.locator.pageEnd === 'number' ? { pageEnd: segment.locator.pageEnd } : {}),
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
