import { validContext } from '@shared/ai'

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
    if (!limit || options.canRetry?.() === false) throw error
    options.learn(limit)
    return request(Math.min(options.context, limit), true)
  }
}
