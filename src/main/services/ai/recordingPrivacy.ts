import { canReadSource } from '../attachmentsAccess'
import { eq } from 'drizzle-orm'
import { getDb } from '../../db'
import { sources, notes } from '../../db/schema'
import { voiceText } from '../voiceMessages'
import type { ChatSend } from '@shared/schemas'
import type { SearchHit } from '@shared/types'
import { assertReadableUrl } from '../retrieval/pagePolicy'
import { assertPageReadable } from '../retrieval/reader'

/** 选区/就地问题本身可能带原话，不能只过滤附加上下文。每次云端发送前重读开关。 */
export function requireRecordingCloudAccess(input: ChatSend, conversationId: string | null = input.conversationId): void {
  const anchors = [...(input.context?.targets ?? []), input.context?.viewport, input.anchor].filter((a) => a?.parentType === 'source')
  const ids = new Set([input.context?.sourceId, ...anchors.map((a) => a?.parentId)].filter((id): id is string => !!id))
  for (const id of ids) {
    const source = getDb().select().from(sources).where(eq(sources.id, id)).get()
    if (!source || !canReadSource(id, conversationId)) throw new Error(voiceText('sourceNoCloud'))
  }
}
export function filterCloudHits(hits: SearchHit[], conversationId: string | null = null): SearchHit[] {
  return hits.filter((hit) => {
    if (hit.parentType === 'web') {
      try {
        if (!hit.url) return false
        assertReadableUrl(hit.url)
        if (hit.meta?.pdfUrl) assertReadableUrl(hit.meta.pdfUrl)
        if (hit.parentId) assertPageReadable(hit.parentId)
        return true
      } catch {
        return false
      }
    }
    if (hit.parentType === 'source') return canReadSource(hit.parentId, conversationId)
    const table = notes
    const parent = getDb()
      .select({ aiExcluded: table.aiExcluded, deletedAt: table.deletedAt })
      .from(table)
      .where(eq(table.id, hit.parentId))
      .get()
    return parent && !parent.aiExcluded && !parent.deletedAt
  })
}
