import type { ContextPacket, ProjectReaderSource } from '@shared/context'
import { api } from '@/lib/utils'
import i18n from '@/i18n'

/** 阅读器可以打开附件，但新对话不能自动继承上一次阅读器里的私有资料。 */
export async function attachmentContext(
  packet: ContextPacket,
  conversationId: string | null,
  ids: string[],
  options: { readerSource?: ProjectReaderSource; requireCurrentSource?: boolean } = {}
): Promise<ContextPacket> {
  const allowed = new Set([
    ...ids,
    ...(options.readerSource && packet.sourceId === options.readerSource.sourceId ? [options.readerSource.sourceId] : []),
    ...(conversationId ? (await api.attachments.ofConversation(conversationId)).map((a) => a.sourceId) : [])
  ])
  const sourceIds = new Set(
    [
      packet.sourceId,
      ...packet.targets.filter((a) => a.parentType === 'source').map((a) => a.parentId),
      packet.viewport?.parentType === 'source' ? packet.viewport.parentId : null
    ].filter((id): id is string => !!id)
  )
  const hidden = new Set<string>()
  for (const id of sourceIds) {
    const s = await api.sources.get(id)
    if (s?.space === 'attachment' && !allowed.has(id)) {
      if (options.requireCurrentSource && packet.sourceId === id) throw new Error(i18n.t('assist.privateSourceUnavailable'))
      hidden.add(id)
    }
  }
  return {
    ...packet,
    sourceId: packet.sourceId && hidden.has(packet.sourceId) ? null : packet.sourceId,
    targets: packet.targets.filter((a) => a.parentType !== 'source' || !hidden.has(a.parentId)),
    viewport: packet.viewport?.parentType === 'source' && hidden.has(packet.viewport.parentId) ? null : packet.viewport
  }
}
