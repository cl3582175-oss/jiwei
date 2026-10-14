import i18n from 'i18next'
import { UiEventSchema, type UiEvent } from '@shared/ui/events'
import type { UiNode } from '@shared/ui/catalog'
import { replyInConversation } from '@/features/chat/MessageItem'
import type { UiContext } from './context'

export const canReply = (ctx: UiContext): boolean => ctx.context === 'chat' && ctx.isLatest && !ctx.streaming && !ctx.stopped
/** 只发送用户选择或模型原始节点，真实数据的读取结果永不进入事件。 */
export function sendUiReply(ctx: UiContext, node: UiNode, uiKey: string, action: UiEvent['action'], text: string, value: unknown): void {
  if (!canReply(ctx)) return
  const event = UiEventSchema.parse({ messageId: ctx.messageId, componentId: uiKey, type: node.type, action, value })
  replyInConversation(ctx.conversationId, text, event)
}
export function restyle(ctx: UiContext, node: UiNode, uiKey: string): void {
  const value = { type: node.type, node }
  sendUiReply(
    ctx,
    node,
    uiKey,
    'restyle',
    i18n.t('ui.event.restyle'),
    new TextEncoder().encode(JSON.stringify(value)).length <= 8192 ? value : { type: node.type, title: node.title }
  )
}
