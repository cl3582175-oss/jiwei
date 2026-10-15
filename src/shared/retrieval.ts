import { z } from 'zod'

export const WEB_BACKENDS = ['bocha', 'zhipu', 'tavily', 'brave', 'exa', 'serper', 'searxng'] as const
export const ACADEMIC_BACKENDS = ['openalex', 'semanticscholar', 'arxiv'] as const
export const BACKEND_IDS = [...WEB_BACKENDS, ...ACADEMIC_BACKENDS] as const
export type WebBackendId = (typeof WEB_BACKENDS)[number]
export type AcademicBackendId = (typeof ACADEMIC_BACKENDS)[number]
export type BackendId = (typeof BACKEND_IDS)[number]

export const WebModeSchema = z.enum(['off', 'auto', 'always'])
export type WebMode = z.infer<typeof WebModeSchema>
export const SearchTypeSchema = z.enum(['web', 'news', 'academic'])
export type SearchType = z.infer<typeof SearchTypeSchema>
export const FreshnessSchema = z.enum(['day', 'week', 'month', 'year'])
export type Freshness = z.infer<typeof FreshnessSchema>

/** 一条搜索结果（各后端统一成这个形状） */
export interface WebResult {
  url: string // 规范化后的网址
  title: string
  snippet: string // 纯文本，最多 600 字
  publishedAt?: number // 毫秒
  site?: string // 站点名或主机名
  backend: BackendId
  rank: number // 在该后端结果中的名次，从 1 开始
  content?: string // 后端直接返回的正文（如 Exa text、智谱 content_size=high），最多 8000 字
  // 学术结果才有
  doi?: string
  authors?: string[] // 最多 6 个
  year?: number
  venue?: string
  citations?: number
  pdfUrl?: string // 开放获取全文
}

export interface BackendState {
  id: BackendId
  kind: 'web' | 'academic'
  keySet: boolean // 有自己的 Key，或使用了服务商的 Key
  keyProviderId: string | null // 仅 zhipu
  baseUrl: string | null // 仅 searxng
  enabled: boolean
  needsKey: boolean
  /** 熔断中：连续失败后暂停到这个时间（毫秒） */
  pausedUntil: number | null
}

export interface RetrievalStatus {
  backends: BackendState[]
  /** 至少有一个网页搜索后端可用（启用且配置完整、未熔断） */
  webAvailable: boolean
  academicEnabled: boolean
  today: { calls: number; limit: number }
}

export const BackendSaveSchema = z.object({
  id: z.enum(BACKEND_IDS),
  /** undefined：不改；空字符串：清除 */
  key: z.string().max(4000).optional(),
  /** 仅 zhipu：null 表示改用自己的 Key */
  keyProviderId: z.string().max(64).nullable().optional(),
  /** 仅 searxng */
  baseUrl: z.string().max(500).optional(),
  enabled: z.boolean()
})
export type BackendSave = z.infer<typeof BackendSaveSchema>

export const RetrievalSettingsSchema = z.object({
  autoUpgrade: z.boolean(),
  mode: WebModeSchema,
  preferZh: z.enum(WEB_BACKENDS).nullable(),
  preferEn: z.enum(WEB_BACKENDS).nullable(),
  academic: z.boolean(),
  cautious: z.boolean(),
  dailyLimit: z.number().int().min(10).max(5000),
  trustedSites: z.array(z.string().max(200)).max(200),
  lowTrustSites: z.array(z.string().max(200)).max(200)
})
export type RetrievalSettings = z.infer<typeof RetrievalSettingsSchema>

export const RETRIEVAL_DEFAULTS: RetrievalSettings = {
  autoUpgrade: true,
  mode: 'auto',
  preferZh: null,
  preferEn: null,
  academic: true,
  cautious: false,
  dailyLimit: 300,
  trustedSites: [],
  lowTrustSites: []
}

/** 网页快照（引用卡片打开时用） */
export interface WebPageView {
  id: string
  url: string
  title: string
  siteName: string | null
  publishedAt: number | null
  fetchedAt: number
  method: 'fetch' | 'render' | 'pdf'
  text: string
}

export interface RetrievalUsage {
  range: 'today' | 'month'
  total: number
  cached: number
  failed: number
  byBackend: { backend: string; calls: number }[]
}

export const BACKEND_INFO: Record<
  BackendId,
  {
    name: string
    langs: ('zh' | 'en' | '*')[]
    needsKey: boolean
    keyUrl?: string
    freshness: boolean
    site: boolean
    returnsContent: boolean
  }
> = {
  bocha: {
    name: '博查 · Bocha',
    langs: ['zh'],
    needsKey: true,
    keyUrl: 'https://open.bochaai.com/',
    freshness: true,
    site: false,
    returnsContent: false
  },
  zhipu: {
    name: '智谱 · Zhipu Web Search',
    langs: ['zh'],
    needsKey: true,
    keyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
    freshness: true,
    site: true,
    returnsContent: true
  },
  tavily: {
    name: 'Tavily',
    langs: ['en', 'zh'],
    needsKey: true,
    keyUrl: 'https://app.tavily.com/',
    freshness: true,
    site: true,
    returnsContent: false
  },
  brave: {
    name: 'Brave Search',
    langs: ['en'],
    needsKey: true,
    keyUrl: 'https://brave.com/search/api/',
    freshness: true,
    site: true,
    returnsContent: false
  },
  exa: { name: 'Exa', langs: ['en'], needsKey: true, keyUrl: 'https://exa.ai/', freshness: true, site: true, returnsContent: true },
  serper: {
    name: 'Serper（Google 结果）',
    langs: ['en', 'zh'],
    needsKey: true,
    keyUrl: 'https://serper.dev/',
    freshness: true,
    site: true,
    returnsContent: false
  },
  searxng: { name: 'SearXNG（自建）', langs: ['*'], needsKey: false, freshness: true, site: true, returnsContent: false },
  openalex: {
    name: 'OpenAlex',
    langs: ['*'],
    needsKey: false,
    keyUrl: 'https://openalex.org/',
    freshness: false,
    site: false,
    returnsContent: false
  },
  semanticscholar: {
    name: 'Semantic Scholar',
    langs: ['en'],
    needsKey: false,
    keyUrl: 'https://www.semanticscholar.org/product/api',
    freshness: false,
    site: false,
    returnsContent: false
  },
  arxiv: { name: 'arXiv', langs: ['en'], needsKey: false, freshness: false, site: false, returnsContent: false }
}
