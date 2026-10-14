import { z } from 'zod'
import { neutralizeUiFences } from './sanitize'

export const UiEventSchema = z.object({
  messageId: z.string().min(1).max(64),
  componentId: z.string().max(80),
  type: z.string().max(20),
  action: z.enum(['choose', 'submit', 'edit', 'restyle']),
  value: z.unknown().refine((value) => {
    try {
      return new TextEncoder().encode(JSON.stringify(value) ?? 'null').length <= 8192
    } catch {
      return false
    }
  }, '组件操作数据超过 8 KB')
})
export type UiEvent = z.infer<typeof UiEventSchema>
const attribute = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!)
/** 用户的操作不属于外部内容，不改变工具审批污点；只作为有界数据附加。 */
export function appendUiEvent(text: string, event?: UiEvent): string {
  if (!event) return text
  const checked = UiEventSchema.parse(event)
  const json = (JSON.stringify(checked.value, (_key, value) => (typeof value === 'string' ? neutralizeUiFences(value) : value)) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
  return `${text}\n\n<ui-event component="${attribute(checked.componentId)}" type="${attribute(checked.type)}" action="${checked.action}">${json}</ui-event>`
}
