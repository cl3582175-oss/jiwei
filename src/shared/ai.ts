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
 * 模型价格（美元 / 百万 token，高峰期标价），用于费用估算。未知模型不显示费用。
 * DeepSeek 官网标价，2026-10-09 查证；如有变动以官网为准。
 *   - deepseek-flash（V4.1-Flash，能看图）；旧名 deepseek-v4-flash / deepseek-v4-flash-vision-exp 路由到它，同价
 *   - deepseek-v4-pro（V4-Pro-0813，纯文本）
 */
export const MODEL_PRICES: Record<string, { input: number; cachedInput?: number; output: number; offPeak?: 'deepseek' }> = {
  'deepseek-flash': { input: 0.3, cachedInput: 0.006, output: 1.2, offPeak: 'deepseek' },
  'deepseek-v4-flash': { input: 0.3, cachedInput: 0.006, output: 1.2, offPeak: 'deepseek' },
  'deepseek-v4-flash-vision-exp': { input: 0.3, cachedInput: 0.006, output: 1.2, offPeak: 'deepseek' },
  'deepseek-v4-pro': { input: 1.32, cachedInput: 0.044, output: 3.96, offPeak: 'deepseek' }
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

export function estimateCost(model: string, u: Usage, at = Date.now()): number | null {
  const p = MODEL_PRICES[model]
  if (!p) return null
  const uncached = Math.max(0, u.inputTokens - u.cachedInputTokens)
  const full = (uncached * p.input + u.cachedInputTokens * (p.cachedInput ?? p.input) + u.outputTokens * p.output) / 1_000_000
  return p.offPeak === 'deepseek' && !isDeepSeekPeak(at) ? full / 2 : full
}

/* ——— 模型能力 ——— */

/**
 * 两项能力决定积微怎么用一个模型：
 *   - tier：strong / basic，决定可用的技能（如自由 HTML 交互只对强模型开放），以及后台小任务是否换用快速模型；
 *   - vision：能否看图，决定框选区域 / 视频画面提问时是否发送图像（否则只发送区域内的文字）。
 * 默认按名称自动判断（下面两张表）；服务商经常改名、升级，所以用户可以在「AI 模型」设置中逐个模型改写，
 * 改写存于服务商的 modelCaps，优先于自动判断。
 */
export type ModelTier = 'basic' | 'strong'
export interface ModelCapsOverride {
  vision?: boolean
  tier?: ModelTier
}
export interface ModelCaps {
  vision: boolean
  tier: ModelTier
  /** 按名称自动判断的结果（界面上显示“自动”时用） */
  auto: { vision: boolean; tier: ModelTier }
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
export function resolveCaps(model: string, overrides?: Record<string, ModelCapsOverride> | null): ModelCaps {
  const auto = { vision: autoVision(model), tier: autoTier(model) }
  const o = overrides?.[model]
  return { vision: o?.vision ?? auto.vision, tier: o?.tier ?? auto.tier, auto }
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
