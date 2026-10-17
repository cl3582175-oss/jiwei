import { z } from 'zod'
import { AnnotationSelectorSchema } from './schemas'
import { locatorFields } from './context'
import type { Segment } from './types'

/** Reuse annotation selectors for transient navigation and persisted links. */
export const SourceSelectorSchema = AnnotationSelectorSchema.extend({ pageEnd: z.number().int().min(1).optional() })
export type SourceSelector = z.infer<typeof SourceSelectorSchema>

export function hasSourceSelector(selector: SourceSelector): boolean {
  return !!(
    selector.ownerId ||
    selector.quote ||
    selector.page ||
    selector.t ||
    selector.rects?.length ||
    (selector.start !== undefined && selector.end !== undefined)
  )
}

export function readSourceSelector(value: unknown): SourceSelector | undefined {
  try {
    const raw = typeof value === 'string' ? JSON.parse(value) : value
    if (!raw || typeof raw !== 'object') return undefined
    const parsed = SourceSelectorSchema.safeParse({
      ...raw,
      ...(typeof raw.value === 'string' ? locatorFields(raw.value) : {}),
      ...(typeof raw.exact === 'string' && !raw.quote ? { quote: raw.exact } : {})
    })
    return parsed.success && hasSourceSelector(parsed.data) ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export function selectorOfSegment(segment: Segment): SourceSelector {
  const value = typeof segment.locator.value === 'string' ? segment.locator.value : null
  return {
    ownerId: segment.id,
    // The citation's evidence preview, rather than a fabricated model quotation.
    ...(segment.text ? { quote: segment.text.slice(0, 280) } : {}),
    ...locatorFields(value),
    ...(typeof segment.locator.page === 'number' ? { page: segment.locator.page } : {}),
    ...(typeof segment.locator.pageEnd === 'number' ? { pageEnd: segment.locator.pageEnd } : {})
  }
}

export function selectorFromParams(q: URLSearchParams): SourceSelector {
  const raw = q.get('target')
  if (raw && raw.length <= 32000) {
    try {
      const parsed = SourceSelectorSchema.safeParse(JSON.parse(raw))
      if (parsed.success) return parsed.data
    } catch {
      /* Legacy query parameters below remain usable. */
    }
  }
  const number = (name: string) => (q.has(name) ? Number(q.get(name)) : undefined)
  const time = q.get('t')?.split(',').map(Number)
  const parsed = SourceSelectorSchema.safeParse({
    ownerId: q.get('seg') ?? undefined,
    page: number('page'),
    pageEnd: number('pageEnd'),
    quote: q.get('quote') ?? undefined,
    prefix: q.get('prefix') ?? undefined,
    suffix: q.get('suffix') ?? undefined,
    start: number('start'),
    end: number('end'),
    t: time ? [time[0], time[1] ?? time[0]] : undefined
  })
  return parsed.success ? parsed.data : {}
}

export function selectorLocator(selector: SourceSelector): string | null {
  return selector.page ? `page=${selector.page}` : selector.t ? `t=${selector.t.join(',')}` : null
}
