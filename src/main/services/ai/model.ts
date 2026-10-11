import { net } from 'electron'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai'
import { checkBudget, recordUsage } from '../agent/usage'
import { currentRun } from '../agent/context'
import { PROVIDER_PRESETS, type Effort, type ProviderKind } from '@shared/ai'
import { decryptKey, getProviderRow } from './providers'

// 由服务商配置构建 AI SDK 模型，并把统一的“思考强度”映射为各家参数。

export interface ModelRequest {
  providerId: string
  model: string
  effort: Effort
}

export interface BuiltModel {
  model: LanguageModel
  /** 传给 streamText 的服务商专用参数 */
  providerOptions?: Record<string, Record<string, unknown>>
  /** 思考模式下最大输出需要放宽 */
  maxOutputTokens?: number
}

/** 不支持的档位就近取支持的档位（如 DeepSeek 没有“中”，取“高”） */
export function clampEffort(kind: ProviderKind, effort: Effort): Effort {
  const allowed = PROVIDER_PRESETS[kind].efforts
  if (allowed.includes(effort)) return effort
  const order: Effort[] = ['off', 'low', 'medium', 'high', 'max']
  const i = order.indexOf(effort)
  for (let d = 1; d < order.length; d++) {
    if (allowed.includes(order[i + d])) return order[i + d]
    if (allowed.includes(order[i - d])) return order[i - d]
  }
  return allowed[0]
}

const ANTHROPIC_BUDGET: Record<Effort, number> = { off: 0, low: 2048, medium: 8192, high: 24576, max: 63999 }
const GEMINI_BUDGET: Record<Effort, number> = { off: 0, low: 1024, medium: 8192, high: 24576, max: -1 }
const QWEN_BUDGET: Record<Effort, number> = { off: 0, low: 1024, medium: 4096, high: 16384, max: 38912 }
const OPENAI_EFFORT: Record<Effort, string> = { off: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'high' }

/** OpenAI 兼容接口的请求体扩展（按服务商注入思考参数） */
function compatibleBody(kind: ProviderKind, effort: Effort, sendEffort: boolean): Record<string, unknown> {
  if (!sendEffort) return {}
  switch (kind) {
    case 'deepseek':
      // 官方：thinking.type 开关 + reasoning_effort（low / high / max）
      return effort === 'off' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, reasoning_effort: effort }
    case 'qwen':
      return effort === 'off' ? { enable_thinking: false } : { enable_thinking: true, thinking_budget: QWEN_BUDGET[effort] }
    case 'openai':
      return { reasoning_effort: OPENAI_EFFORT[effort] }
    case 'zhipu':
      return { thinking: { type: effort === 'off' ? 'disabled' : 'enabled' } }
    default:
      return effort === 'off' ? {} : { reasoning_effort: effort === 'max' ? 'high' : effort }
  }
}

type ProviderUsage = {
  inputTokens: { total?: number; cacheRead?: number }
  outputTokens: { total?: number; reasoning?: number }
}
const toUsage = (u: ProviderUsage) => ({
  inputTokens: u.inputTokens.total ?? 0,
  outputTokens: u.outputTokens.total ?? 0,
  reasoningTokens: u.outputTokens.reasoning ?? 0,
  cachedInputTokens: u.inputTokens.cacheRead ?? 0
})

/**
 * 记账与费用上限（v0.7）：每次请求前检查上限，结束后按服务商返回的 token 数记一条。
 * 流式请求的回调可能不在原来的异步上下文里，所以在发起时取出当前运行。
 */
function meter(providerId: string, model: string): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate }) => {
      checkBudget()
      const run = currentRun()
      const result = await doGenerate()
      recordUsage(providerId, model, toUsage(result.usage), run)
      return result
    },
    wrapStream: async ({ doStream }) => {
      checkBudget()
      const run = currentRun()
      const result = await doStream()
      const stream = result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (part.type === 'finish') recordUsage(providerId, model, toUsage(part.usage), run)
            controller.enqueue(part)
          }
        })
      )
      return { ...result, stream }
    }
  }
}

export function buildModel(req: ModelRequest): BuiltModel {
  const built = buildRawModel(req)
  return { ...built, model: wrapLanguageModel({ model: built.model as never, middleware: meter(req.providerId, req.model) }) }
}

function buildRawModel(req: ModelRequest): BuiltModel {
  const row = getProviderRow(req.providerId)
  const kind = row.kind as ProviderKind
  const preset = PROVIDER_PRESETS[kind]
  const apiKey = decryptKey(row) ?? undefined
  if (preset.needsKey && !apiKey) throw new Error(`「${row.name}」还没有设置 API Key`)
  const effort = clampEffort(kind, req.effort)
  const fetch = net.fetch as unknown as typeof globalThis.fetch

  if (preset.style === 'anthropic') {
    const provider = createAnthropic({ baseURL: row.baseUrl, apiKey, fetch })
    return {
      model: provider(req.model),
      providerOptions:
        effort === 'off' ? undefined : { anthropic: { thinking: { type: 'enabled', budgetTokens: ANTHROPIC_BUDGET[effort] } } },
      maxOutputTokens: effort === 'off' ? 8192 : ANTHROPIC_BUDGET[effort] + 8192
    }
  }
  if (preset.style === 'google') {
    const provider = createGoogleGenerativeAI({ baseURL: row.baseUrl, apiKey, fetch })
    return {
      model: provider(req.model),
      providerOptions: { google: { thinkingConfig: { thinkingBudget: GEMINI_BUDGET[effort], includeThoughts: effort !== 'off' } } }
    }
  }
  const provider = createOpenAICompatible({
    name: 'jiwei',
    baseURL: row.baseUrl,
    apiKey,
    fetch,
    includeUsage: true,
    transformRequestBody: (body) => ({ ...body, ...compatibleBody(kind, effort, row.sendEffort) })
  })
  return { model: provider(req.model), maxOutputTokens: effort === 'max' ? 65536 : effort === 'off' ? 8192 : 32768 }
}
