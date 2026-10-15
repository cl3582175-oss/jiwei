import { toUsd, type MoneySettings } from './money'
// AI 服务商预设、统一的“思考强度”与各家参数映射。
//
// 思考强度对用户统一为五档：关闭 / 低 / 中 / 高 / 极限。
// 每家服务商只显示它支持的档位，并在主进程（main/services/ai/model.ts）映射为各自的请求参数：
//   DeepSeek   thinking.type + reasoning_effort（low / high / max）
//   OpenAI     reasoning_effort（minimal / low / medium / high）
//   Anthropic  thinking.budget_tokens
//   Gemini     thinkingConfig.thinkingBudget
//   通义千问    enable_thinking + thinking_budget
//   其他兼容接口 reasoning_effort（可在服务商设置中关闭）

export const EFFORTS = ['off', 'low', 'medium', 'high', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

/** API 风格：决定使用哪个 SDK 适配器 */
export type ApiStyle = 'openai-compatible' | 'anthropic' | 'google'

export type ProviderKind = 'deepseek' | 'openai' | 'anthropic' | 'google' | 'qwen' | 'moonshot' | 'zhipu' | 'ollama' | 'custom'

export interface ProviderPreset {
  kind: ProviderKind
  name: string
  style: ApiStyle
  baseURL: string
  /** 获取 API Key 的网址 */
  keyUrl?: string
  needsKey: boolean
  /** 该服务商支持的思考档位（第一个为默认值） */
  efforts: Effort[]
  defaultEffort: Effort
  /** 常用模型（可在设置中刷新或手动添加） */
  models: string[]
  /** 支持向量（embedding）接口时的推荐模型 */
  embeddingModels?: string[]
}

export const PROVIDER_PRESETS: Record<ProviderKind, ProviderPreset> = {
  deepseek: {
    kind: 'deepseek',
    name: 'DeepSeek',
    style: 'openai-compatible',
    baseURL: 'https://api.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    needsKey: true,
    // DeepSeek 实际支持 low / high / max；“中”映射到 high
    efforts: ['off', 'low', 'high', 'max'],
    defaultEffort: 'high',
    // deepseek-flash：V4.1-Flash，能看图；deepseek-v4-pro：V4-Pro-0813，纯文本旗舰（2026-10-09 实测）
    models: ['deepseek-flash', 'deepseek-v4-pro']
  },
  openai: {
    kind: 'openai',
    name: 'OpenAI',
    style: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    needsKey: true,
    efforts: ['off', 'low', 'medium', 'high'],
    defaultEffort: 'medium',
    models: [],
    embeddingModels: ['text-embedding-3-small', 'text-embedding-3-large']
  },
  anthropic: {
    kind: 'anthropic',
    name: 'Anthropic Claude',
    style: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    needsKey: true,
    efforts: ['off', 'low', 'medium', 'high', 'max'],
    defaultEffort: 'medium',
    models: []
  },
  google: {
    kind: 'google',
    name: 'Google Gemini',
    style: 'google',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    keyUrl: 'https://aistudio.google.com/apikey',
    needsKey: true,
    efforts: ['off', 'low', 'medium', 'high', 'max'],
    defaultEffort: 'medium',
    models: []
  },
  qwen: {
    kind: 'qwen',
    name: '通义千问',
    style: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    needsKey: true,
    efforts: ['off', 'low', 'medium', 'high', 'max'],
    defaultEffort: 'medium',
    models: [],
    embeddingModels: ['text-embedding-v4']
  },
  moonshot: {
    kind: 'moonshot',
    name: 'Kimi（月之暗面）',
    style: 'openai-compatible',
    baseURL: 'https://api.moonshot.cn/v1',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    needsKey: true,
    efforts: ['off', 'low', 'medium', 'high'],
    defaultEffort: 'off',
    models: []
  },
  zhipu: {
    kind: 'zhipu',
    name: '智谱 GLM',
    style: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    needsKey: true,
    efforts: ['off', 'low', 'medium', 'high'],
    defaultEffort: 'off',
    models: [],
    embeddingModels: ['embedding-3']
  },
  ollama: {
    kind: 'ollama',
    name: 'Ollama（本地）',
    style: 'openai-compatible',
    baseURL: 'http://127.0.0.1:11434/v1',
    needsKey: false,
    efforts: ['off', 'low', 'medium', 'high'],
    defaultEffort: 'off',
    models: []
  },
  custom: {
    kind: 'custom',
    name: '自定义（OpenAI 兼容）',
    style: 'openai-compatible',
    baseURL: '',
    needsKey: true,
    efforts: ['off', 'low', 'medium', 'high'],
    defaultEffort: 'off',
    models: []
  }
}

export const PROVIDER_ORDER: ProviderKind[] = ['deepseek', 'qwen', 'moonshot', 'zhipu', 'openai', 'anthropic', 'google', 'ollama', 'custom']

/**
 * 模型单价（每百万 token），用于费用估算。currency 为服务商的标价币种，记账时按汇率换成美元。
 *   - input：未命中缓存的输入；cachedInput：命中缓存的输入（不设则按 input 计）；output：输出（含思考）
 *   - offPeak：有错峰折扣的服务商（目前只有 DeepSeek，低谷半价）
 */
export interface ModelPrice {
  currency: string
  input: number
  cachedInput?: number
  output: number
  offPeak?: 'deepseek'
}

/** 价格来源：用户在「AI 模型」里填写的 / 内置官网价 / 内置参考价（二手资料，请核对） */
export type PriceSource = 'custom' | 'official' | 'reference'

const usd = (input: number, cachedInput: number | undefined, output: number): ModelPrice => ({
  currency: 'USD',
  input,
  cachedInput,
  output
})
const cny = (input: number, cachedInput: number | undefined, output: number): ModelPrice => ({
  currency: 'CNY',
  input,
  cachedInput,
  output
})

/**
 * 内置模型价格（高峰期 / 标准档 / 最低阶梯标价），2026-10-11 查证，以官网为准：
 *   - DeepSeek：api-docs.deepseek.com（美元标价；低谷半价）
 *   - OpenAI / Anthropic / Google：各官网定价页（美元）
 *   - Kimi：platform.kimi.com（人民币）
 *   - 通义千问：阿里云百炼北京地域（人民币）；缓存命中价官网未列，按隐式缓存 20% 估算
 *   - 智谱：官网定价页无法读取，取多个转售平台一致的报价，标为参考价
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'deepseek-flash': { ...usd(0.3, 0.006, 1.2), offPeak: 'deepseek' },
  'deepseek-v4-flash': { ...usd(0.3, 0.006, 1.2), offPeak: 'deepseek' },
  'deepseek-v4-flash-vision-exp': { ...usd(0.3, 0.006, 1.2), offPeak: 'deepseek' },
  'deepseek-v4-pro': { ...usd(1.32, 0.044, 3.96), offPeak: 'deepseek' },
  'gpt-6-astra': usd(10, 1, 50),
  'gpt-6.1-sol': usd(2, 0.1, 10),
  'gpt-6-sol': usd(2, 0.2, 10),
  'gpt-6-luna': usd(0.1, 0.01, 0.5),
  'gpt-5.6-sol': usd(4, 0.4, 20),
  'gpt-5.6-terra': usd(2, 0.2, 12),
  'gpt-5.6-luna': usd(0.2, 0.02, 1.2),
  'gpt-5.5': usd(5, 0.5, 30),
  'gpt-5.4': usd(2.5, 0.25, 15),
  'gpt-5.4-mini': usd(0.75, 0.075, 4.5),
  'gpt-5.4-nano': usd(0.2, 0.02, 1.25),
  'gpt-5.2': usd(1.75, 0.175, 14),
  'gpt-5.1': usd(1.25, 0.125, 10),
  'gpt-5': usd(1.25, 0.125, 10),
  'gpt-5-mini': usd(0.25, 0.025, 2),
  'gpt-5-nano': usd(0.05, 0.005, 0.4),
  'gpt-4.1': usd(2, 0.5, 8),
  'gpt-4.1-mini': usd(0.4, 0.1, 1.6),
  'gpt-4.1-nano': usd(0.1, 0.025, 0.4),
  'gpt-4o': usd(2.5, 1.25, 10),
  'gpt-4o-mini': usd(0.15, 0.075, 0.6),
  'claude-fable-5-1': usd(10, 0.25, 50),
  'claude-fable-5': usd(10, 1, 50),
  'claude-opus-5-5': usd(4, 0.2, 20),
  'claude-opus-5': usd(5, 0.5, 25),
  'claude-opus-4-8': usd(5, 0.5, 25),
  'claude-opus-4-7': usd(5, 0.5, 25),
  'claude-opus-4-6': usd(5, 0.5, 25),
  'claude-opus-4-5': usd(5, 0.5, 25),
  'claude-sonnet-5-5': usd(2, 0.1, 10),
  'claude-sonnet-5': usd(2, 0.2, 10),
  'claude-sonnet-4-6': usd(3, 0.3, 15),
  'claude-sonnet-4-5': usd(3, 0.3, 15),
  'claude-haiku-5-5': usd(0.1, 0.01, 0.5),
  'claude-haiku-4-5': usd(1, 0.1, 5),
  'gemini-3.8-flash': usd(0.75, 0.075, 3.75),
  'gemini-3.6-flash': usd(0.75, 0.075, 3.75),
  'gemini-3.5-flash-lite': usd(0.3, 0.03, 2.5),
  'gemini-3.1-flash-lite': usd(0.25, 0.025, 1.5),
  'gemini-3.1-pro-preview': usd(2, 0.2, 12),
  'gemini-3-flash-preview': usd(0.5, 0.05, 3),
  'gemini-2.5-pro': usd(1.25, 0.125, 10),
  'gemini-2.5-flash': usd(0.3, 0.03, 2.5),
  'gemini-2.5-flash-lite': usd(0.1, 0.01, 0.4),
  'kimi-k3': cny(20, 2, 100),
  'kimi-k2.7-code': cny(6.5, 1.3, 27),
  'kimi-k2.7-code-highspeed': cny(13, 2.6, 54),
  'kimi-k2.6': cny(6.5, 1.1, 27),
  'qwen3.8-max': cny(12, 2.4, 36),
  'qwen3.8-flash': cny(0.8, 0.1, 2.7),
  'qwen3.7-plus': cny(2, 0.4, 8),
  'qwen3.6-plus': cny(2, 0.4, 12),
  'qwen-max': cny(2.4, 0.48, 9.6),
  'qwen-plus': cny(0.8, 0.16, 2),
  'qwen-flash': cny(0.15, 0.03, 1.5),
  'glm-5.3': cny(8, 2, 28),
  'glm-5.3-flash': cny(0.8, 0.23, 2.8),
  // 语音合成：按“字符数”计（记账时 inputTokens 填计费字符数）。通义官网 ¥0.8 / 万字符；
  // OpenAI gpt-4o-mini-tts 按分钟计费（约 $0.015 / 分钟），按中文约 250 字 / 分钟折算为参考价
  'qwen3-tts-flash': cny(80, undefined, 0),
  'gpt-4o-mini-tts': usd(30, undefined, 0)
}

/** 二手资料的参考价（界面上提示“请核对”） */
const REFERENCE_PRICES = new Set(['glm-5.3', 'glm-5.3-flash', 'qwen3.8-max', 'qwen3.7-plus', 'gpt-4o-mini-tts'])

/** 带日期后缀的模型名（gpt-5.4-2026-03-05、claude-sonnet-4-5-20250929）按基础名查价 */
function presetKey(model: string): string | null {
  const m = model.toLowerCase()
  if (MODEL_PRICES[m]) return m
  const base = m.replace(/[-@](\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, '')
  return MODEL_PRICES[base] ? base : null
}

/** 某模型的价格：用户填写的优先，否则用内置价格；都没有时为 null */
export function resolvePrice(model: string, custom?: ModelPrice | null): { price: ModelPrice; source: PriceSource } | null {
  if (custom) return { price: custom, source: 'custom' }
  const key = presetKey(model)
  if (!key) return null
  return { price: MODEL_PRICES[key], source: REFERENCE_PRICES.has(key) ? 'reference' : 'official' }
}

/**
 * DeepSeek 错峰：高峰为周一至周五 UTC 01:00–04:00、06:00–10:00，其余时间半价。
 * 官网另说明中国法定节假日全天为低谷，这里无法得知节假日，按工作日估算（偏高，不会少算）。
 */
export function isDeepSeekPeak(at: number): boolean {
  const d = new Date(at)
  const day = d.getUTCDay()
  if (day === 0 || day === 6) return false
  const h = d.getUTCHours()
  return (h >= 1 && h < 4) || (h >= 6 && h < 10)
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cachedInputTokens: number
}

/** 按标价币种计算的费用（未换算） */
export function priceCost(p: ModelPrice, u: Usage, at = Date.now()): number {
  const uncached = Math.max(0, u.inputTokens - u.cachedInputTokens)
  const full = (uncached * p.input + u.cachedInputTokens * (p.cachedInput ?? p.input) + u.outputTokens * p.output) / 1_000_000
  return p.offPeak === 'deepseek' && !isDeepSeekPeak(at) ? full / 2 : full
}

/**
 * 估算费用（美元）：price 不传时用内置价格；标价不是美元时按汇率换算（rates 不传用内置参考汇率）。
 * 价格或汇率未知时为 null。
 */
export function estimateCost(
  model: string,
  u: Usage,
  at = Date.now(),
  price?: ModelPrice | null,
  money?: Pick<MoneySettings, 'rates'> | null
): number | null {
  const p = price ?? resolvePrice(model)?.price
  if (!p) return null
  return toUsd(priceCost(p, u, at), p.currency, money)
}

/** 高峰期价格与实际价格之差（美元）：低谷时段省下的钱 */
export function offPeakSaving(p: ModelPrice, u: Usage, at: number, money?: Pick<MoneySettings, 'rates'> | null): number {
  if (p.offPeak !== 'deepseek' || isDeepSeekPeak(at)) return 0
  return toUsd(priceCost(p, u, at), p.currency, money) ?? 0
}

/* ——— 模型能力 ——— */

/**
 * 三项能力决定积微怎么用一个模型：
 *   - tier：strong / basic，决定可用的技能（如自由 HTML 交互只对强模型开放），以及后台小任务是否换用快速模型；
 *   - vision：能否看图，决定框选区域 / 视频画面提问时是否发送图像（否则只发送区域内的文字）。
 *   - tools：工具调用是否可靠；不可靠时可由代码先搜索，再把结果交给模型。
 * 默认按名称自动判断（下面两张表）；服务商经常改名、升级，所以用户可以在「AI 模型」设置中逐个模型改写，
 * 改写存于服务商的 modelCaps，优先于自动判断。
 */
export type ModelTier = 'basic' | 'strong'
export interface ModelCapsOverride {
  vision?: boolean
  tools?: boolean
  tier?: ModelTier
  /** 用户手动设定的上下文预算（词元） */
  context?: number
  /** 主进程发现/学习的自动预算，与手动覆盖分开保存 */
  reportedContext?: number
  learnedContext?: number
  /** 用户填写的价格（v0.7.5），优先于内置价格 */
  price?: ModelPrice
  learnedMaxOutput?: number
}
export interface ModelCaps {
  vision: boolean
  tools: boolean
  tier: ModelTier
  context: number
  contextSource: ContextSource
  /** 按名称自动判断的结果（界面上显示“自动”时用） */
  auto: { vision: boolean; tools: boolean; tier: ModelTier; context: number; contextSource: Exclude<ContextSource, 'manual'> }
}

export type ContextSource = 'manual' | 'provider' | 'error' | 'builtin' | 'default'
export const validContext = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1024 && value <= 100_000_000

/** 仅用于预算兜底，不代表服务商保证的官方上限。 */
function builtinContext(model: string, kind: ProviderKind): number | null {
  if (kind === 'ollama') return null
  if (/^deepseek-(?:flash|v4(?:\.1)?-(?:flash|pro))(?:-|$)/i.test(model)) return 1_000_000
  if (/^minimax-/i.test(model)) return 1_000_000
  if (/^deepseek-(?:chat|reasoner)$/i.test(model)) return 128000
  if (/^qwen-(?:plus|turbo)/i.test(model)) return 32768
  if (/^kimi-|^moonshot-/i.test(model)) return 128000
  if (/^glm-/i.test(model)) return 32768
  if (/^gpt-|^o[1-4](?:-|$)/i.test(model)) return 128000
  if (/^claude-/i.test(model)) return 200000
  if (/^gemini-/i.test(model)) return 1048576
  return null
}

/** 按名称识别的旗舰模型；无法识别的视为 basic（宁可降级为模板，也不产出低质量结果） */
const STRONG_MODELS = [
  // DeepSeek V4-Pro-0813：纯文本旗舰（2026-10 实测仍独立提供，不能看图）
  /deepseek-v4-pro/i,
  /deepseek-reasoner/i,
  /claude-(opus|sonnet)/i,
  /gpt-5(?!.*(nano|mini))/i,
  /gemini-[\d.]+-pro/i,
  /qwen[\d.]*-max/i,
  /kimi-k2/i,
  /glm-[45]/i
]

/** 按名称识别的能看图的模型（2026-10 查证） */
const VISION_MODELS = [
  // DeepSeek V4.1-Flash 原生多模态（2026-09-10）；旧名 deepseek-v4-flash 也路由到它
  /^deepseek-flash/i,
  /deepseek-v4(\.1)?-flash/i,
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-5/i,
  /claude/i,
  /gemini/i,
  /-vl/i,
  /vision/i,
  /glm-4v/i,
  /glm-4\.\dv/i,
  /qwen.*omni/i,
  /llava/i,
  /llama3\.2-vision/i,
  /pixtral/i
]

export const autoTier = (model: string): ModelTier => (STRONG_MODELS.some((r) => r.test(model)) ? 'strong' : 'basic')
export const autoVision = (model: string): boolean => VISION_MODELS.some((r) => r.test(model))

/** 模型的实际能力：用户设定优先，否则按名称自动判断 */
export function resolveCaps(model: string, overrides?: Record<string, ModelCapsOverride> | null, kind: ProviderKind = 'custom'): ModelCaps {
  const o = overrides?.[model]
  const builtin = builtinContext(model, kind)
  const context = validContext(o?.reportedContext)
    ? o.reportedContext
    : validContext(o?.learnedContext)
      ? o.learnedContext
      : (builtin ?? (kind === 'ollama' ? 8192 : 65536))
  const contextSource = validContext(o?.reportedContext)
    ? 'provider'
    : validContext(o?.learnedContext)
      ? 'error'
      : builtin
        ? 'builtin'
        : 'default'
  const auto = { vision: autoVision(model), tools: true, tier: autoTier(model), context, contextSource } as ModelCaps['auto']
  return {
    vision: o?.vision ?? auto.vision,
    tools: o?.tools ?? auto.tools,
    tier: o?.tier ?? auto.tier,
    context: validContext(o?.context) ? o.context : context,
    contextSource: validContext(o?.context) ? 'manual' : contextSource,
    auto
  }
}

/* ——— 向量模型 ——— */

/** 内置向量模型：EmbeddingGemma 2（llama.cpp 本地运行），MRL 截断为 512 维 */
export const LOCAL_EMBEDDING = {
  id: 'local:embeddinggemma-2',
  name: 'EmbeddingGemma 2（本地）',
  dim: 512,
  /** 检索提示词格式（模型卡要求） */
  queryPrefix: 'task: search result | query: ',
  docPrefix: (title: string): string => `title: ${title || 'none'} | text: `
} as const

export const EMBEDDING_DIM = 512
