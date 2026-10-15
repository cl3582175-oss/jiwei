import { tool, type LanguageModelUsage, type ModelMessage } from 'ai'
import { z } from 'zod'
import { resolveCaps, type Effort } from '@shared/ai'
import { extractJson } from '../../lib/learner'
import { buildModel } from './model'
import { withPurpose } from '../agent/context'
import { getProviderRow, learnOutputLimit } from './providers'
import { generateWithIdle, logModelFailure, ModelOutputTruncated, rejectedOutputLimit } from './request'

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
  /** 来源未知时保守隐藏失败诊断正文；明确公开的调用方才传 false。 */
  sensitive?: boolean
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
    abortSignal: opts.signal
  }
  const stored = JSON.parse(getProviderRow(opts.providerId).modelCaps) as Record<string, { learnedMaxOutput?: number }>
  const storedLimit = stored[opts.model]?.learnedMaxOutput
  let learned = storedLimit && Number.isSafeInteger(storedLimit) && storedLimit > 0 ? storedLimit : Infinity
  let budget = Math.min(Math.max(opts.maxOutputTokens ?? 0, built.maxOutputTokens ?? 8192), learned)
  let lengthRetried = false
  let last: Awaited<ReturnType<typeof generateWithIdle>> | undefined
  const diagnostics = (phase: 'tool' | 'json') => ({ purpose: opts.purpose, model: opts.model, phase, sensitive: opts.sensitive ?? true })
  const request = async (phase: 'tool' | 'json') => {
    let pendingLimit: number | null = null
    while (true) {
      opts.guard?.()
      try {
        const r = await generateWithIdle({
          ...base,
          maxOutputTokens: budget,
          system:
            phase === 'tool'
              ? opts.system
              : `${opts.system}\n\nOutput only one JSON object matching this JSON Schema, with no other text:\n${JSON.stringify(z.toJSONSchema(opts.schema))}`,
          ...input,
          ...(phase === 'tool'
            ? {
                tools: { submit: tool({ description: 'Submit the result', inputSchema: opts.schema }) },
                toolChoice: { type: 'tool' as const, toolName: 'submit' }
              }
            : {}),
          diagnostics: diagnostics(phase)
        })
        last = r
        opts.onUsage?.(r.usage)
        opts.guard?.()
        if (pendingLimit !== null) {
          learnOutputLimit(opts.providerId, opts.model, pendingLimit)
          learned = pendingLimit
          pendingLimit = null
        }
        if (r.finishReason !== 'length') return r
        if (lengthRetried) throw new ModelOutputTruncated(r.usage)
        lengthRetried = true
        budget = Math.min(budget * 2, 65536, learned)
      } catch (error) {
        if (opts.signal?.aborted) throw error
        const limit = rejectedOutputLimit(error, budget)
        if (limit === null) throw error
        budget = limit
        pendingLimit = limit
      }
    }
  }
  opts.guard?.()
  try {
    const r = await request('tool')
    const call = r.toolCalls.find((c) => c.toolName === 'submit')
    if (call) return opts.schema.parse(call.input)
    throw new Error('No tool call in model output')
  } catch (e) {
    logModelFailure('structured', diagnostics('tool'), last)
    if (opts.signal?.aborted || e instanceof ModelOutputTruncated) throw e
  }
  opts.guard?.()
  last = undefined
  try {
    const r = await request('json')
    return opts.schema.parse(extractJson(r.text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')))
  } catch (e) {
    logModelFailure('structured', diagnostics('json'), last)
    throw e
  }
}
