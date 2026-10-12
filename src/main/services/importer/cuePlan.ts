import type { DocJSON } from '@shared/types'
import { nodeText } from '../../lib/derive'
/** Match only empty cues; bound each prompt while covering every eligible row in batches. */
export function cueBodies(doc: DocJSON): { blockId?: string; body: string }[] {
  return (doc.content ?? [])
    .filter((n) => n.type === 'cornellRow')
    .flatMap((row) => {
      const cue = row.content?.find((n) => n.type === 'cornellCue')?.content?.[0],
        body = row.content?.find((n) => n.type === 'cornellBody')
      if (!cue || !body || nodeText(cue).trim()) return []
      const text = nodeText(body).trim().slice(0, 1500)
      return text ? [{ blockId: typeof cue.attrs?.id === 'string' ? cue.attrs.id : undefined, body: text }] : []
    })
}
export const CUE_BATCH = 10
