import { net } from 'electron'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { wrapLanguageModel, type streamText, type LanguageModel, type LanguageModelMiddleware } from 'ai'
import { checkBudget, recordUsage } from '../agent/usage'
import { currentRun } from '../agent/context'
import { PROVIDER_PRESETS, normalizeEffort, resolveModelPolicy, type Effort, type LegacyEffort, type ProviderKind } from '@shared/ai'
import { decryptKey, getProviderRow } from './providers'

// 由服务商配置构建 AI SDK 模型，并把统一的“思考强度”映射为各家参数。

export interface ModelRequest {
  providerId: string
  model: string
  effort: Effort
  /** 后台来源处理可在每次 SDK 尝试前复核授权。 */
  fetch?: typeof globalThis.fetch
}

export interface BuiltModel {
  model: LanguageModel
  /** 本轮显式发送的档位；未确认或关闭发送时不伪装成用户偏好。 */
  effectiveEffort: Effort | null
  /** 传给 streamText 的服务商专用参数 */
  providerOptions?: Parameters<typeof streamText>[0]['providerOptions']
  /** 思考模式下最大输出需要放宽 */
  maxOutputTokens?: number
}

const ANTHROPIC_BUDGET: Record<LegacyEffort, number> = { off: 0, low: 2048, medium: 8192, high: 24576, max: 63999 }
const GEMINI_BUDGET: Record<LegacyEffort, number> = { off: 0, low: 1024, medium: 8192, high: 24576, max: -1 }
const QWEN_BUDGET: Record<LegacyEffort, number> = { off: 0, low: 1024, medium: 4096, high: 16384, max: 38912 }
const OPENAI_EFFORT: Record<LegacyEffort, string> = { off: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'high' }

/** OpenAI 兼容接口的请求体扩展（按服务商注入思考参数） */
function compatibleBody(kind: ProviderKind, effort: LegacyEffort, sendEffort: boolean): Record<string, unknown> {
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
      const t0 = Date.now()
      const result = await doGenerate()
      recordUsage(providerId, model, toUsage(result.usage), run, Date.now() - t0)
      return result
    },
    wrapStream: async ({ doStream }) => {
      checkBudget()
      const run = currentRun()
      const t0 = Date.now()
      const result = await doStream()
      const stream = result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (part.type === 'finish') recordUsage(providerId, model, toUsage(part.usage), run, Date.now() - t0)
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
  if (!row.baseUrl) throw new Error(`「${row.name}」还没有填写接口地址`)
  if (preset.needsKey && !apiKey) throw new Error(`「${row.name}」还没有设置 API Key`)
  const fetch = req.fetch ?? (net.fetch as unknown as typeof globalThis.fetch)
  const policy = resolveModelPolicy({ kind, baseUrl: row.baseUrl, sendEffort: row.sendEffort }, req.model)
  const effectiveEffort = normalizeEffort(policy, req.effort)
  if (policy.api === 'openai-chat' || policy.api === 'openai-responses') {
    const provider = createOpenAI({ baseURL: row.baseUrl, apiKey, fetch })
    const reasoningEffort = effectiveEffort === 'off' ? 'none' : effectiveEffort === 'openai-max' ? 'max' : effectiveEffort
    const reasoning = reasoningEffort ? { reasoningEffort } : {}
    return {
      model: policy.api === 'openai-responses' ? provider.responses(req.model) : provider.chat(req.model),
      effectiveEffort,
      providerOptions:
        policy.api === 'openai-responses'
          ? { openai: { store: false, reasoningSummary: null, ...reasoning } }
          : reasoningEffort
            ? { openai: reasoning }
            : undefined,
      maxOutputTokens:
        effectiveEffort === 'openai-max'
          ? 65536
          : !effectiveEffort || effectiveEffort === 'off' || effectiveEffort === 'minimal'
            ? 8192
            : 32768
    }
  }
  // 兼容接口即使关闭思考参数，也沿用原来的输出预算；新值先回到旧档位边界。
  const effort = normalizeEffort({ api: preset.style, efforts: preset.efforts, effortStatus: 'enabled' }, req.effort) as LegacyEffort

  if (preset.style === 'anthropic') {
    const provider = createAnthropic({ baseURL: row.baseUrl, apiKey, fetch })
    return {
      model: provider(req.model),
      effectiveEffort,
      providerOptions:
        effort === 'off' ? undefined : { anthropic: { thinking: { type: 'enabled', budgetTokens: ANTHROPIC_BUDGET[effort] } } },
      maxOutputTokens: effort === 'off' ? 8192 : ANTHROPIC_BUDGET[effort] + 8192
    }
  }
  if (preset.style === 'google') {
    const provider = createGoogleGenerativeAI({ baseURL: row.baseUrl, apiKey, fetch })
    return {
      model: provider(req.model),
      effectiveEffort,
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
  return { model: provider(req.model), effectiveEffort, maxOutputTokens: effort === 'max' ? 65536 : effort === 'off' ? 8192 : 32768 }
}
