import type { DocJSON } from '@shared/types'
import { nodeText } from '../../lib/derive'
import { imagesIn, noteContentText } from '../../lib/noteImageText'
/** Match only empty cues; bound each prompt while covering every eligible row in batches. */
export function cueBodies(doc: DocJSON, imageText?: (id: string) => string | null, zh = false): { blockId?: string; body: string }[] {
  return (doc.content ?? [])
    .filter((n) => n.type === 'cornellRow')
    .flatMap((row) => {
      const cue = row.content?.find((n) => n.type === 'cornellCue')?.content?.[0],
        body = row.content?.find((n) => n.type === 'cornellBody')
      if (!cue || !body || nodeText(cue).trim()) return []
      const text = imagesIn(body).length ? noteContentText(body, zh, imageText).trim().slice(0, 6000) : nodeText(body).trim().slice(0, 1500)
      return text ? [{ blockId: typeof cue.attrs?.id === 'string' ? cue.attrs.id : undefined, body: text }] : []
    })
}
export const CUE_BATCH = 10
