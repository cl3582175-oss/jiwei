import { generateText, tool, type LanguageModelUsage, type ModelMessage } from 'ai'
import { z } from 'zod'
import log from 'electron-log/main'
import { resolveCaps, type Effort } from '@shared/ai'
import { extractJson } from '../../lib/learner'
import { buildModel } from './model'
import { withPurpose } from '../agent/context'
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
  effort?: Effort
  images?: { data: Uint8Array; mediaType: string }[]
  onUsage?: (usage: LanguageModelUsage) => void
  signal?: AbortSignal
  /** 长流程每次发请求（含回退）前重读隐私与取消状态。 */
  guard?: () => void
  /** 记账用途（v0.7）；不填时沿用外层（后台任务按任务类型） */
  purpose?: string
  /** 输出上限；长结构（如几十个排期时段）需要调高，否则 JSON 会被截断 */
  maxOutputTokens?: number
}): Promise<T> {
  return opts.purpose ? withPurpose(opts.purpose, () => run(opts)) : run(opts)
}

async function run<T>(opts: Parameters<typeof structured<T>>[0]): Promise<T> {
  const built = buildModel({ providerId: opts.providerId, model: opts.model, effort: opts.effort ?? 'off' })
  const input = opts.images?.length
    ? {
        messages: [
          {
            role: 'user',
            content: [
              ...opts.images.map((i) => ({ type: 'image' as const, image: i.data, mediaType: i.mediaType })),
              { type: 'text', text: opts.prompt }
            ]
          }
        ] as ModelMessage[]
      }
    : { prompt: opts.prompt }
  const base = {
    model: built.model,
    providerOptions: built.providerOptions as never,
    maxOutputTokens: opts.effort && opts.effort !== 'off' ? (built.maxOutputTokens ?? 32768) : (opts.maxOutputTokens ?? 4096),
    // 长输出给足时间（约 40 token/s）
    abortSignal: opts.signal ?? AbortSignal.timeout((opts.maxOutputTokens ?? 0) > 4096 ? 240_000 : 90_000)
  }
  try {
    opts.guard?.()
    const r = await generateText({
      ...base,
      system: opts.system,
      ...input,
      tools: { submit: tool({ description: 'Submit the result', inputSchema: opts.schema }) },
      toolChoice: { type: 'tool', toolName: 'submit' }
    })
    opts.onUsage?.(r.usage)
    opts.guard?.()
    const call = r.toolCalls.find((c) => c.toolName === 'submit')
    if (call) return opts.schema.parse(call.input)
    log.warn('[structured] no tool call, falling back to JSON text')
  } catch (e) {
    if (opts.signal?.aborted) throw e
    log.warn('[structured] tool call failed, falling back to JSON text:', e instanceof Error ? e.message : e)
  }
  opts.guard?.()
  const r = await generateText({
    ...base,
    system: `${opts.system}\n\nOutput only one JSON object matching this JSON Schema, with no other text:\n${JSON.stringify(z.toJSONSchema(opts.schema))}`,
    ...input
  })
  opts.onUsage?.(r.usage)
  opts.guard?.()
  return opts.schema.parse(extractJson(r.text))
}
