import { eq } from 'drizzle-orm'
import { getDb } from '../../db'
import { sources, notes } from '../../db/schema'
import { voiceText } from '../voiceMessages'
import type { ChatSend } from '@shared/schemas'
import type { SearchHit } from '@shared/types'

/** 选区/就地问题本身可能带原话，不能只过滤附加上下文。每次云端发送前重读开关。 */
export function requireRecordingCloudAccess(input: ChatSend): void {
  const anchors = [...(input.context?.targets ?? []), input.context?.viewport, input.anchor].filter((a) => a?.parentType === 'source')
  const ids = new Set([input.context?.sourceId, ...anchors.map((a) => a?.parentId)].filter((id): id is string => !!id))
  for (const id of ids) {
    const source = getDb().select().from(sources).where(eq(sources.id, id)).get()
    if (!source || source.aiExcluded || source.deletedAt) throw new Error(voiceText('sourceNoCloud'))
  }
}
export function filterCloudHits(hits: SearchHit[]): SearchHit[] {
  return hits.filter((hit) => {
    const table = hit.parentType === 'source' ? sources : notes
    const parent = getDb()
      .select({ aiExcluded: table.aiExcluded, deletedAt: table.deletedAt })
      .from(table)
      .where(eq(table.id, hit.parentId))
      .get()
    return parent && !parent.aiExcluded && !parent.deletedAt
  })
}
