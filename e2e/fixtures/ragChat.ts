import { expect, type Page } from '@playwright/test'
import type { ChatMessage } from '../../src/shared/types'
import type { Effort } from '../../src/shared/ai'
import type { ChatScope } from '../../src/shared/schemas'

/** 只经现成对话接口；凭证始终留在 Electron 主进程。 */
export async function askInApp(
  page: Page,
  input: {
    providerId: string
    model: string
    text: string
    scope: ChatScope
    conversationId?: string | null
    incognito?: boolean
    effort?: Effort
  }
): Promise<{ conversationId: string; message: ChatMessage }> {
  const sent = await page.evaluate(
    (input) =>
      window.jiwei.chat.send({ ...input, conversationId: input.conversationId ?? null, effort: input.effort ?? 'off', web: 'off' }),
    input
  )
  let message: ChatMessage | null = null
  try {
    await expect
      .poll(
        async () => {
          message =
            (await page.evaluate((id) => window.jiwei.chat.messages(id), sent.conversation.id)).find(
              (m) => m.id === sent.assistantMessageId
            ) ?? null
          return message && message.status !== 'streaming'
        },
        { timeout: 300_000, intervals: [1000] }
      )
      .toBe(true)
  } catch (error) {
    // 超时不能留下仍在运行的请求；保留停止后的原消息，后续只补缺失评分。
    await page.evaluate((id) => window.jiwei.chat.stop(id), sent.assistantMessageId).catch(() => {})
    message =
      (await page.evaluate((id) => window.jiwei.chat.messages(id), sent.conversation.id).catch(() => [])).find(
        (m) => m.id === sent.assistantMessageId
      ) ?? message
    if (!message) throw error
  }
  if (!message) throw new Error('回答消息没有持久化')
  return { conversationId: sent.conversation.id, message: message as ChatMessage }
}
