import { validContext } from '@shared/ai'
import type { BuiltModel } from './model'

/** 只采信明确标注的输入/上下文上限，绝不把请求长度、输出限额或限流数字学成窗口。 */
export function contextLimitFromError(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error)
  for (const pattern of [
    /maximum\s+context\s+length\s*(?:is|of|:|=)\s*([\d,]+)/i,
    /max(?:imum)?\s+context\s+window\s*(?:is|of|:|=)\s*([\d,]+)/i,
    /(?:model\s+supports|context[^.\n]{0,40})\s+(?:at\s+most|up\s+to)\s+([\d,]+)\s*tokens/i,
    /(?:max_input_tokens|inputTokenLimit|max_context_length|context_length)\s*["':=\s]+([\d,]+)/i
  ]) {
    const match = message.match(pattern)
    const n = match ? Number(match[1].replace(/,/g, '')) : null
    if (validContext(n)) return n
  }
  return null
}

/** 重新调用的是组装+发送全过程，避免仅重发原来超长的消息；已经开始工具/输出的请求不可回放。 */
export async function withContextWindowRetry<T>(
  request: (context: number, retry: boolean) => Promise<T>,
  options: { context: number; learn: (context: number) => void; canRetry?: () => boolean }
): Promise<T> {
  try {
    return await request(options.context, false)
  } catch (error) {
    const limit = contextLimitFromError(error)
    if (!limit) throw error
    options.learn(limit)
    if (options.canRetry?.() === false) throw error
    try {
      return await request(Math.min(options.context, limit), true)
    } catch (second) {
      const next = contextLimitFromError(second)
      if (next && next !== limit) options.learn(next)
      throw second
    }
  }
}

/** 输入含系统/工具估算，额外保留协议开销；缩窗口时输出和思考预算必须同步收缩。 */
export function contextGenerationBudget(
  context: number,
  inputTokens: number,
  built: Pick<BuiltModel, 'maxOutputTokens' | 'providerOptions'>
): Pick<BuiltModel, 'maxOutputTokens' | 'providerOptions'> {
  const maxOutputTokens = Math.min(built.maxOutputTokens ?? 8192, Math.max(1, Math.floor(context - Math.ceil(inputTokens) - 1024)))
  const providerOptions = built.providerOptions ? structuredClone(built.providerOptions) : undefined
  const anthropic = providerOptions?.anthropic?.thinking as { type?: string; budgetTokens?: number } | undefined
  if (anthropic?.type === 'enabled' && typeof anthropic.budgetTokens === 'number') {
    if (maxOutputTokens <= 1024) providerOptions!.anthropic.thinking = { type: 'disabled' }
    else anthropic.budgetTokens = Math.min(anthropic.budgetTokens, Math.max(1024, maxOutputTokens - 1024))
  }
  const google = providerOptions?.google?.thinkingConfig as { thinkingBudget?: number } | undefined
  if (typeof google?.thinkingBudget === 'number' && google.thinkingBudget > 0)
    google.thinkingBudget = Math.min(google.thinkingBudget, Math.max(0, maxOutputTokens - 1024))
  return { maxOutputTokens, providerOptions }
}
