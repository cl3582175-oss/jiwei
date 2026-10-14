import { expect, type Page } from '@playwright/test'
import type { ChatMessage } from '../../src/shared/types'
import type { ChatScope } from '../../src/shared/schemas'

/** 只经现成对话接口；凭证始终留在 Electron 主进程。 */
export async function askInApp(
  page: Page,
  input: { providerId: string; model: string; text: string; scope: ChatScope; conversationId?: string | null; incognito?: boolean }
): Promise<{ conversationId: string; message: ChatMessage }> {
  const sent = await page.evaluate(
    (input) => window.jiwei.chat.send({ ...input, conversationId: input.conversationId ?? null, effort: 'off', web: 'off' }),
    input
  )
  let message: ChatMessage | null = null
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
  if (!message) throw new Error('回答消息没有持久化')
  return { conversationId: sent.conversation.id, message: message as ChatMessage }
}
