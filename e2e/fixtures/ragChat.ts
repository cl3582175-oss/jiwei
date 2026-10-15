import { expect, type Page } from '@playwright/test'
import type { ChatMessage } from '../../src/shared/types'
import type { Effort } from '../../src/shared/ai'
import type { ChatScope } from '../../src/shared/schemas'

export interface PendingAnswer {
  conversationId: string
  messageId: string
}
export class UnsettledAnswerError extends Error {
  readonly name = 'UnsettledAnswerError'
  readonly conversationId: string
  readonly messageId: string
  stage?: 'previous'
  constructor(
    identity: PendingAnswer,
    readonly snapshot: ChatMessage | null
  ) {
    super('停止后仍未确认原消息终态，必须恢复同一消息，不能继续模型请求')
    this.conversationId = identity.conversationId
    this.messageId = identity.messageId
  }
}

/** stop只发出abort；只有读取到终态才能进入下一次请求采集或评分。 */
export async function terminalAnswer(page: Page, identity: PendingAnswer): Promise<ChatMessage> {
  const deadline = Date.now() + 30_000
  let snapshot: ChatMessage | null = null
  do {
    const messages = await page.evaluate((id) => window.jiwei.chat.messages(id), identity.conversationId).catch(() => [])
    snapshot = messages.find((m) => m.id === identity.messageId) ?? snapshot
    if (snapshot && snapshot.status !== 'streaming') return snapshot
    await new Promise((resolve) => setTimeout(resolve, 250))
  } while (Date.now() < deadline)
  throw new UnsettledAnswerError(identity, snapshot)
}

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
  },
  onSent?: (identity: PendingAnswer) => void
): Promise<{ conversationId: string; message: ChatMessage }> {
  const sent = await page.evaluate(
    (input) =>
      window.jiwei.chat.send({
        providerId: input.providerId,
        model: input.model,
        text: input.text,
        scope: input.scope,
        incognito: input.incognito,
        conversationId: input.conversationId ?? null,
        effort: input.effort ?? 'off',
        web: 'off'
      }),
    input
  )
  const identity = { conversationId: sent.conversation.id, messageId: sent.assistantMessageId }
  onSent?.(identity)
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
  } catch {
    // 超时不能留下仍在运行的请求；保留停止后的原消息，后续只补缺失评分。
    await page.evaluate((id) => window.jiwei.chat.stop(id), sent.assistantMessageId).catch(() => {})
    message = await terminalAnswer(page, identity)
  }
  if (!message) throw new Error('回答消息没有持久化')
  return { conversationId: sent.conversation.id, message: message as ChatMessage }
}
