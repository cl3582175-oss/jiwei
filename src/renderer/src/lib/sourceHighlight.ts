import type { Segment } from '@shared/types'
import { selectorOfSegment, type SourceSelector } from '@shared/sourceTarget'

export type Highlight = {
  type: 'block' | 'segment'
  id: string
  sourceId?: string
  locator?: string | null
  selector?: SourceSelector
  conversationId?: string | null
} | null
export async function resolveSourceHighlight(
  highlight: Highlight,
  resolve: (id: string) => Promise<string | Segment | null>
): Promise<Highlight> {
  if (!highlight || highlight.type !== 'segment' || !highlight.id) return highlight
  const result = await resolve(highlight.id).catch(() => null)
  if (!result || typeof result === 'string') return { ...highlight, id: result ?? '' }
  if (highlight.sourceId && result.sourceId !== highlight.sourceId) return { ...highlight, id: '' }
  return {
    ...highlight,
    id: result.id,
    sourceId: result.sourceId,
    locator: highlight.locator ?? (typeof result.locator.value === 'string' ? result.locator.value : null),
    selector: { ...selectorOfSegment(result), ...highlight.selector, ownerId: result.id }
  }
}
