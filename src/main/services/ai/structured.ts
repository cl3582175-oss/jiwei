import { generateText, tool } from 'ai'
import { z } from 'zod'
import log from 'electron-log/main'
import { resolveCaps } from '@shared/ai'
import { extractJson } from '../../lib/learner'
import { buildModel } from './model'
import { getProviderRow } from './providers'

// 后台小任务（记忆整理、技能偏好归纳）的结构化输出。
// 首选“强制调用一个提交工具”——各家服务商都支持函数调用（DeepSeek、OpenAI 兼容、Claude、Gemini），
// 比各家不一致的 JSON 模式更可靠；不支持时退回到“只输出 JSON”的文本解析。

const NOT_CHAT = /embed|rerank|whisper|tts|audio|speech|transcri|-vl|vision|image/i

/** 小任务用快速模型：当前是强模型时，换用同一服务商的普通模型（如 Claude Opus → Claude Haiku） */
export function quickModel(providerId: string, model: string): string {
  try {
    const row = getProviderRow(providerId)
    const caps = JSON.parse(row.modelCaps) as Parameters<typeof resolveCaps>[1]
    if (resolveCaps(model, caps).tier === 'basic') return model
    const models = JSON.parse(row.models) as string[]
    return models.find((m) => resolveCaps(m, caps).tier === 'basic' && !NOT_CHAT.test(m)) ?? model
  } catch {
    return model
  }
}

export async function structured<T>(opts: {
  providerId: string
  model: string
  system: string
  prompt: string
  schema: z.ZodType<T>
  signal?: AbortSignal
}): Promise<T> {
  const built = buildModel({ providerId: opts.providerId, model: opts.model, effort: 'off' })
  const base = {
    model: built.model,
    providerOptions: built.providerOptions as never,
    maxOutputTokens: 4096,
    abortSignal: opts.signal ?? AbortSignal.timeout(90_000)
  }
  try {
    const r = await generateText({
      ...base,
      system: opts.system,
      prompt: opts.prompt,
      tools: { submit: tool({ description: 'Submit the result', inputSchema: opts.schema }) },
      toolChoice: { type: 'tool', toolName: 'submit' }
    })
    const call = r.toolCalls.find((c) => c.toolName === 'submit')
    if (call) return opts.schema.parse(call.input)
    log.warn('[structured] no tool call, falling back to JSON text')
  } catch (e) {
    if (opts.signal?.aborted) throw e
    log.warn('[structured] tool call failed, falling back to JSON text:', e instanceof Error ? e.message : e)
  }
  const r = await generateText({
    ...base,
    system: `${opts.system}\n\nOutput only one JSON object matching this JSON Schema, with no other text:\n${JSON.stringify(z.toJSONSchema(opts.schema))}`,
    prompt: opts.prompt
  })
  return opts.schema.parse(extractJson(r.text))
}
