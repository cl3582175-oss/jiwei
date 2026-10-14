// 主进程与渲染进程共享的数据类型（输出类型）。
// 输入类型由 zod 模式推导（schemas.ts），API 由能力注册表推导（capabilities.ts）。
import type { Anchor } from './context'
import type { WebMode } from './retrieval'
import type {
  AiSettings,
  AnnotationInput,
  AnnotationPatch,
  AnnotationSelector,
  ChatScope,
  NoteMetaUpdate,
  NoteQuery,
  Origin,
  ProposalInput,
  ProposalOp,
  ProviderInput,
  SourceQuery,
  SourceUpdate
} from './schemas'
import type { Effort, ModelCapsOverride, ProviderKind, Usage } from './ai'
import type { Relation } from './graphRelations'
export type {
  AiSettings,
  AnnotationInput,
  AnnotationPatch,
  AnnotationSelector,
  ChatScope,
  NoteMetaUpdate,
  NoteQuery,
  Origin,
  ProposalInput,
  ProposalOp,
  ProviderInput,
  SourceQuery,
  SourceUpdate
}
export type { JiweiAPI } from './capabilities'
export type { MossStatus } from './moss'

/** Tiptap / ProseMirror 文档 JSON */
export type DocNode = {
  type?: string
  attrs?: Record<string, unknown>
  content?: DocNode[]
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  text?: string
  [key: string]: unknown
}
export type DocJSON = { type: string; content?: DocNode[] }

export type NoteKind = 'cornell' | 'review' | 'reading' | 'free'

/** 各类笔记的文档格式版本：结构变化时递增，并在 main/services/docs.ts 中提供升级逻辑 */
export const DOC_VERSIONS: Record<NoteKind, number> = { cornell: 1, review: 1, reading: 1, free: 1 }
export const DOC_VERSION = DOC_VERSIONS.cornell
/** Yjs 文档中存放富内容块数据的映射名 */
export const EMBEDS_FIELD = 'embeds'
/** Yjs 文档中承载正文的 XmlFragment 名称（Tiptap Collaboration 默认值） */
export const DOC_FIELD = 'default'

export type CategoryKind = 'note' | 'source'

export interface Category {
  id: string
  parentId: string | null
  name: string
  kind: CategoryKind
  color: string | null
  sortOrder: number
  createdAt: number
}

export interface Tag {
  id: string
  name: string
  color: string | null
}

export type KnowledgeStatus = 'active' | 'outdated' | 'disputed'

export interface NoteSummary {
  id: string
  title: string
  kind: NoteKind
  categoryId: string | null
  pinned: boolean
  learnedAt: number
  status: KnowledgeStatus
  supersededBy: string | null
  aiExcluded: boolean
  /** 不复习：线索不再成为复习卡片 */
  reviewExcluded: boolean
  tagIds: string[]
  excerpt: string
  wordCount: number
  /** AI 生成且未经审阅的字数 */
  aiWordCount: number
  createdAt: number
  /** 正文最后修改时间 */
  editedAt: number
  updatedAt: number
  deletedAt: number | null
}

export type Note = NoteSummary

export interface RevisionInfo {
  id: string
  noteId: string
  title: string
  wordCount: number
  reason: 'auto' | 'manual' | 'restore'
  createdAt: number
}

export interface Revision extends RevisionInfo {
  doc: DocJSON
}

export interface BlockInfo {
  id: string
  noteId: string
  kind: string
  section: 'row' | 'cue' | 'body' | 'summary'
  rowId: string | null
  text: string
  origin: 'user' | 'ai' | 'ai_reviewed'
  createdAt: number
  updatedAt: number
}

export type NoteSort = NonNullable<NoteQuery['sort']>

export type SourceKind = 'book' | 'pdf' | 'video' | 'audio' | 'recording' | 'image' | 'document' | 'web' | 'other'

export interface Source {
  recordingScene?: import('./recording').Scene
  id: string
  title: string
  kind: SourceKind
  assetUrl: string | null
  originalName: string | null
  mime: string | null
  size: number
  url: string | null
  author: string | null
  publishedAt: number | null
  accessedAt: number
  categoryId: string | null
  aiExcluded: boolean
  tagIds: string[]
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface ImportResult {
  imported: Source[]
  /** 内容完全相同、已存在于资料库的文件数 */
  duplicates: number
}

export interface AssetRef {
  id: string
  /** 可直接用于 <img src> 的地址：jiwei://asset/<sha256>.<ext> */
  url: string
  mime: string | null
  size: number
}

export type TrashType = 'note' | 'source' | 'category' | 'recording'

export interface TrashItem {
  type: TrashType
  id: string
  title: string
  deletedAt: number
  /** 距离自动永久删除剩余天数 */
  daysLeft: number
}

export interface HeatmapDay {
  date: string // YYYY-MM-DD
  count: number
}

export type ThemeMode = 'system' | 'light' | 'dark'
export type Language = 'zh-CN' | 'en'

/** 复习（FSRS） */
export interface ReviewSettings {
  /** 每天最多学习的新卡片数 */
  newPerDay: number
  /** 目标记忆保持率（0.8～0.97） */
  retention: number
}

export interface ReflectionSettings {
  /** 每日 1 分钟微复盘 */
  daily: boolean
  /** 每周完整复盘 */
  weekly: boolean
  /** 0 = 周日 */
  weeklyDay: number
  /** HH:mm */
  time: string
}

/** 配色方案：青绿山水 / 汝窑天青 / 敦煌 */
export type Palette = 'qinglu' | 'celadon' | 'dunhuang'

/** 有列表栏的页面（v0.7.3） */
export type SidebarPage = 'notes' | 'library' | 'chat'

export interface Settings {
  retrieval: import('./retrieval').RetrievalSettings
  plugins: { recommendedDismissed: boolean }
  discover: {
    dailyLimit: number
    dailyBudget: number
    budgetCurrency: string
    useSearch: boolean
    podcast: boolean
    podcastVoice: import('./discover').PodcastVoice
  }
  tasks: { paused: boolean; launchAtLogin: boolean; keepRunning: boolean }
  plan: { autoComplete: boolean }
  recordingScene?: 'meeting' | 'lecture' | 'thought'
  capture: ReturnType<typeof import('./capture').captureDefaults>
  language: Language
  theme: ThemeMode
  palette: Palette
  reflection: ReflectionSettings
  review: ReviewSettings
  /** 是否已完成首次启动引导 */
  onboarded: boolean
  /** 侧栏（目录 / 资料分类）是否收起 */
  sidebarCollapsed: boolean
  /** 各页面列表栏（v0.7.3）：是否收起、宽度 */
  sidebars?: Partial<Record<SidebarPage, { collapsed: boolean; width: number }>>
  ai: AiSettings
  /** 费用上限（v0.7） */
  budget: import('./agent').Budget
  /** 币种、汇率、省钱选项（v0.7.5） */
  money: import('./money').MoneySettings
  /** 积微作为 MCP 服务端（v0.7） */
  mcpServe: import('./agent').McpServeSettings
  /** 内置浏览器（v0.6.0） */
  browser?: BrowserSettings
  backup?: { external: import('./backup').ExternalBackup }
  updates?: { autoCheck: boolean; feedUrl: string }
}

export interface BrowserSettings {
  networkRules?: import('./browserSafety').NetworkRule[]
  externalSites?: string[]
  /** 搜索引擎（查询词拼接在末尾） */
  searchEngine?: string
  /** 不发送给 AI 的网站（域名，按后缀匹配） */
  aiBlockedSites?: string[]
  /** 主动程度：安静 / 适中（默认）/ 积极 */
  proactivity?: 'quiet' | 'balanced' | 'active'
  course?: { autoTimestamp: boolean; autoSlides: boolean; quiz: boolean }
  /** 浏览器旁的笔记栏（v0.7.2）：在浏览器的哪一侧、占多少（百分比） */
  noteSide?: 'left' | 'right' | 'top' | 'bottom'
  noteSize?: number
}

export interface BrowserVideo {
  /** 同一页面替换主视频时也要撤销旧课程的异步界面操作。 */
  mediaId: string
  currentTime: number
  duration: number
  paused: boolean
  rate: number
  title: string
  ended: boolean
  updatedAt: number
}

export interface CourseState {
  mode: 'auto' | 'local' | 'off'
  transcript: 'waiting' | 'captions' | 'local' | 'complete' | 'needs-install' | 'error' | 'off'
  slides: boolean
  quiz: boolean
  recordingComplete: boolean
  error: string | null
}

export interface CourseQuiz {
  id: string
  sourceId: string
  question: string
  answer: string
  t: number
}

/** 浏览器标签页（v0.6.0） */
export interface BrowserTab {
  id: string
  scope: string
  url: string
  title: string
  favicon: string | null
  loading: boolean
  canBack: boolean
  canForward: boolean
  /** 无痕：不形成记忆、不保留浏览数据、不自动存为资料 */
  incognito: boolean
  /** 敏感页面：AI 已关闭 */
  sensitive: boolean
  /** 已存为资料 */
  sourceId: string | null
  video: BrowserVideo | null
  course: CourseState
  reading?: import('./reading').ReadingState | null
  loginBlocked?: { reason: 'google' | 'youtube'; url: string } | null
  externalNotice?: { site: string; url: string } | null
}

export interface BrowserState {
  tabs: BrowserTab[]
  activeId: string | null
}

/** 网页中选区浮条的操作（内容脚本 → 主进程 → 界面） */
export interface BrowserAction {
  tabId: string
  action: 'explain' | 'clarify' | 'translate' | 'grammar' | 'ask' | 'highlighting' | 'commenting' | 'questioning' | 'annotation'
  quote: string
  prefix: string
  suffix: string
  /** 选区在网页视图中的位置 */
  rect: { x: number; y: number; w: number; h: number }
  /** 点击已有高亮时：批注 ID */
  annotationId?: string
}

/** 打开网页时找到的相关笔记（本地向量，不调用大模型） */
export interface BrowserRelated {
  tabId: string
  url: string
  items: { type: 'note' | 'source'; id: string; title: string; text: string }[]
}

export interface Vault {
  id: string
  name: string
  path: string
  active: boolean
}

export interface Profile {
  userId: string
  name: string
  deviceId: string
  deviceName: string
}

export interface Segment {
  id: string
  sourceId: string
  ordinal: number
  kind: string
  /** W3C 选择器 */
  locator: Record<string, unknown>
  text: string
}

export type ProposalOpStatus = 'pending' | 'accepted' | 'rejected'

export interface Proposal {
  id: string
  noteId: string
  title: string
  ops: ProposalOp[]
  opStatus: ProposalOpStatus[]
  embeds: Record<string, { kind: string; data: unknown }>
  status: 'pending' | 'resolved'
  model: string | null
  sources: Origin['sources'] | null
  /** 用户主动操作产生：打开笔记时直接应用 */
  auto: boolean
  /** 生成这份提案时使用的技能（用于学习技能偏好） */
  skill: string | null
  createdAt: number
}

export interface Job {
  id: string
  kind: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'canceled'
  progress: number
  attempts: number
  error: string | null
  title: string
  /** 去重键（如 transcribe:<资料 ID>），界面据此找到某份资料的任务 */
  key: string | null
  /** 最早开始时间：排到低谷时段的任务在此之前不运行（v0.7.5） */
  runAfter: number
  createdAt: number
  updatedAt: number
}

export interface AppInfo {
  version: string
  dataDir: string
  dataDirIsDefault: boolean
  dataDirInCloud: boolean
  platform: NodeJS.Platform
}

export interface BackupInfo {
  name: string
  size: number
  createdAt: number
  kind: 'auto' | 'pre-migrate' | 'manual' | 'pre-restore'
  format?: 'database' | 'snapshot'
}

export const TRASH_RETENTION_DAYS = 30

/**
 * 工作区上下文：AI 请求时随附，让 AI 知道“你正在看什么”。
 * 由渲染进程实时维护（笔记光标、资料位置与选区）。
 */
export interface WorkspaceContext {
  noteId: string | null
  /** 光标所在块（段落 ID）与所在行 */
  cursorBlockId: string | null
  cursorRowId: string | null
  /** 笔记中选中的文字 */
  noteSelection: string | null
  sourceId: string | null
  /** 资料中的当前位置（W3C 选择器值，如 t=95 或 page=12） */
  sourceLocator: string | null
  /** 资料中选中的文字与所在片段 */
  sourceSelection: string | null
  sourceSegmentId: string | null
}

/* ——— AI ——— */

export interface ProviderInfo {
  needsKey?: boolean
  id: string
  kind: ProviderKind
  name: string
  baseUrl: string
  hasKey: boolean
  /** API Key 末四位提示（明文永不离开主进程） */
  keyHint: string | null
  models: string[]
  /** 用户对模型能力的改写（未改写的按名称自动判断，见 resolveCaps） */
  modelCaps: Record<string, ModelCapsOverride>
  sendEffort: boolean
  enabled: boolean
}

export interface ProviderTestResult {
  ok: boolean
  latencyMs: number
  message: string | null
}

export interface Conversation {
  id: string
  title: string
  scope: ChatScope
  web: WebMode | null
  pinned: boolean
  /** 无痕：不使用、不形成记忆 */
  incognito: boolean
  kind: 'chat' | 'workspace' | 'inline' | 'feynman' | 'reflection'
  /** 就地提问的锚点 */
  anchor: Anchor | null
  /** 费曼练习的信息（kind = feynman） */
  feynman: FeynmanInfo | null
  /** 复盘追问所属的复盘（kind = reflection） */
  reflectionId: string | null
  createdAt: number
  updatedAt: number
}

/* ——— 双向链接（v0.5.0） ——— */

export interface NoteConnections {
  /** 正文中链接到本篇的笔记（及所在段落） */
  backlinks: { noteId: string; title: string; blockId: string | null; text: string }[]
  /** 手动建立的关联（双向） */
  /** relation：关系类型；outgoing 为 true 时读作“本篇 <关系> 对方”，否则“对方 <关系> 本篇” */
  linked: { linkId: string; type: 'note' | 'source'; id: string; title: string; relation: Relation; outgoing: boolean }[]
  /** 按内容相似度推荐的相关笔记 / 资料（mine：本篇中最相似的段落；theirs：对方的段落） */
  related: { type: 'note' | 'source'; id: string; title: string; score: number; mine: string; theirs: string }[]
  /** 正文提到本篇标题、但还没有链接的笔记 */
  mentions: { noteId: string; title: string; blockId: string; text: string }[]
  /** 向量索引是否可用（不可用时没有推荐） */
  vectors: boolean
}

/* ——— 知识结构图（v0.5.1） ——— */

export interface GraphNode {
  /** note:<id> 或 source:<id> */
  key: string
  type: 'note' | 'source'
  id: string
  title: string
  /** 笔记的顶级分类（着色用）；资料为 null */
  categoryId: string | null
  /** 笔记字数 / 资料分段数（节点大小） */
  weight: number
  /** 笔记的掌握情况（与掌握度地图一致） */
  mastery: MasteryStatus | null
  /** 正文开头一句（悬停卡片用） */
  excerpt: string
  /** 知识状态：已过时 / 存疑时在图上标出 */
  status: 'active' | 'outdated' | 'disputed' | null
  createdAt: number
}

export interface GraphEdge {
  from: string
  to: string
  /** reference 正文链接；related 手动关联；source 引用资料 */
  kind: 'reference' | 'related' | 'source'
  /** 关系类型（v0.14.2）：读作“from <关系> to”；正文链接为 related */
  relation: Relation
  /** AI 建议的关系为 suggested（v0.14.3 起） */
  status: 'confirmed' | 'suggested'
}

export interface KnowledgeGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  categories: { id: string; name: string; color: string | null }[]
}

/* ——— 方向与掌握度（v0.4.3） ——— */

/**
 * 一篇笔记的掌握情况（由复习卡片的 FSRS 状态计算）：
 * blank 有内容但没有线索问题；new 有卡片但还没复习过；weak / learning / solid 按记忆强度与当前记得的概率
 */
export type MasteryStatus = 'blank' | 'new' | 'weak' | 'learning' | 'solid'

export interface NoteMastery {
  id: string
  title: string
  categoryId: string | null
  cards: number
  reviewed: number
  /** 复习过的卡片现在还记得的平均概率（FSRS 可提取性） */
  recall: number | null
  /** 平均记忆稳定性（天） */
  stability: number | null
  lapses: number
  status: MasteryStatus
  /** 笔记中出现的、学习情况为“薄弱”的概念 */
  weakConcepts: string[]
}

export interface MasteryMap {
  categories: { id: string; name: string; parentId: string | null }[]
  notes: NoteMastery[]
  totals: Record<MasteryStatus, number>
}

export interface Goal {
  id: string
  kind: 'exam' | 'skill' | 'project' | 'interest'
  startAt: number | null
  weeklyMinutes: number | null
  weekdayMinutes: number[] | null
  color: string | null
  title: string
  description: string | null
  status: 'active' | 'achieved' | 'paused' | 'dropped'
  targetAt: number | null
  /** 关联的分类（含子分类） */
  categoryId: string | null
  /** 手动关联的笔记 */
  noteIds: string[]
  createdAt: number
}

export interface GoalProgress {
  goal: Goal
  minutesThisWeek: number
  plannedMinutesThisWeek: number
  notes: number
  cards: number
  reviewed: number
  /** 掌握比例：牢固的卡片 / 全部卡片 */
  mastered: number
  recall: number | null
  reviews7d: number
  weakNotes: number
  blankNotes: number
  openActions: number
  daysLeft: number | null
}

/* ——— 复盘（v0.4.2） ——— */

/** daily 每日微复盘；weekly 每周复盘（GRAI）；topic 主题；practice 实践；belief 认知变化 */
export type ReflectionKind = 'daily' | 'weekly' | 'topic' | 'practice' | 'belief'

export interface Reflection {
  id: string
  kind: ReflectionKind
  /** 复盘正文：一篇 kind = review 的康奈尔笔记（线索栏是引导问题，笔记栏是你的回答） */
  noteId: string | null
  title: string
  periodStart: number | null
  periodEnd: number | null
  /** 专题复盘的范围（主题文字 / 分类 / 标签） */
  scope: { topic?: string; categoryId?: string; tagId?: string } | null
  status: 'draft' | 'done'
  completedAt: number | null
  createdAt: number
}

/** 复盘素材包：由数据统计生成（不经过 AI），既给你看，也作为 AI 追问的依据 */
export interface ReflectionMaterial {
  mistakes: import('./learningStats').MistakeStatistics
  period: { start: number; end: number }
  notes: { id: string; title: string; editedAt: number; created: boolean }[]
  episodes: { content: string; at: number; conversationId: string | null }[]
  review: { reviewed: number; forgot: number; hardest: { question: string; noteId: string; lapses: number }[] }
  /** 有线索、笔记栏还空着的行 */
  unanswered: { question: string; noteId: string; noteTitle: string }[]
  concepts: { name: string; level: 'weak' | 'learning' | 'solid'; change: 'up' | 'down' | 'new' }[]
  feynman: { concept: string; level: 'weak' | 'learning' | 'solid' | null; conversationId: string }[]
  /** 到期或期间完成的行动项（闭环检查） */
  actions: ActionItem[]
  /** 进行中的方向及进度 */
  goals: { id: string; title: string; mastered: number; reviews7d: number; daysLeft: number | null }[]
  /** 期间新增的批注：高亮总数；有评论或存疑的条目 */
  annotations: {
    highlights: number
    items: {
      id: string
      targetType: 'note' | 'source'
      targetId: string
      targetTitle: string
      quote: string | null
      body: string | null
      question: boolean
      page: number | null
      ownerId: string | null
    }[]
  }
  /** 供 AI 使用的文字版 */
  text: string
}

export type InsightConfidence = 'hypothesis' | 'believed' | 'verified'

export interface Insight {
  id: string
  statement: string
  confidence: InsightConfidence
  status: 'active' | 'revised' | 'refuted'
  version: number
  /** 首次提出它的复盘 */
  reviewId: string | null
  createdAt: number
  updatedAt: number
}

export interface InsightVersion {
  version: number
  statement: string
  confidence: InsightConfidence
  /** 为什么这样改（第一版为依据） */
  reason: string | null
  createdAt: number
}

export interface ActionItem {
  id: string
  phaseId?: string | null
  title: string
  status: 'open' | 'done' | 'dropped'
  dueAt: number | null
  doneAt: number | null
  reviewId: string | null
  goalId: string | null
  ownerPersonId?: string | null
  ownerName?: string | null
  origin?: import('./lens').LensOrigin | null
  createdAt: number
}

/** 复盘完成时 AI 从正文中提炼的候选（由用户确认后保存） */
export interface ReflectionHarvest {
  insights: { statement: string; confidence: InsightConfidence; evidence: string }[]
  /** 对已有洞见的修正（认知变化） */
  revisions: { insightId: string; current: string; statement: string; confidence: InsightConfidence; reason: string }[]
  actions: { title: string; dueInDays: number | null }[]
}

export interface ReflectionOverview {
  today: Reflection | null
  week: Reflection | null
  /** 本周复盘的时间范围 */
  weekStart: number
  weekEnd: number
  recent: Reflection[]
  openActions: ActionItem[]
  insights: number
}

/* ——— 费曼练习（v0.4.1） ——— */

export interface FeynmanInfo {
  /** 要讲清楚的概念 */
  concept: string
  /** 关联的笔记（参考资料来源；漏洞补进这篇笔记） */
  noteId: string | null
  /** 从复习卡片进入时的卡片 */
  cardId: string | null
  /** 讲完后的诊断 */
  report: FeynmanReport | null
}

export interface FeynmanReport {
  /** 一两句总体评价（先肯定讲清楚的部分） */
  verdict: string
  level: 'weak' | 'learning' | 'solid'
  /** 讲清楚了的 */
  clear: string[]
  /** 没讲清楚 / 漏掉的，以及可以怎样补 */
  gaps: { point: string; hint: string }[]
  /** 说错的地方 */
  misconceptions: string[]
  /** 建议补进笔记的线索问题（问题 + 简短答案），进入复习 */
  cues: { question: string; answer: string }[]
  finishedAt: number
}

/** AI 执行过程中的一步（调用工具、加载技能） */
export interface AgentStep {
  id: string
  tool: string
  /** 给用户看的简短说明，如“检索知识库：遗忘曲线” */
  label: string
  /** waiting：等待用户确认；denied：用户拒绝、超时或策略禁止 */
  status: 'running' | 'waiting' | 'done' | 'error' | 'denied'
  /** 结果摘要或错误 */
  detail?: string
  /** 可跳转的目标（如生成的提案所在笔记） */
  link?: { type: 'note' | 'source' | 'action' | 'goal' | 'inbox' | 'task'; id: string }
  /** 需要用户确认的一步（v0.7） */
  approval?: {
    id: string
    title: string
    detail?: string
    level: import('./agent').ToolLevel
    tainted: boolean
    state: 'pending' | 'allowed' | 'denied' | 'expired'
  }
  /** 来自外部 MCP 服务器时的服务器名称 */
  server?: string
  /** AI 向用户提的选择题（v0.7.6，ask_user）：界面显示为可点的选项 */
  choices?: { question: string; options: string[] }
}

/** 回答引用的知识库片段 */
export interface Citation {
  /** 回答中的引用编号 [n] */
  n: number
  parentType: 'note' | 'source' | 'web'
  parentId: string
  /** 笔记块 ID 或资料片段 ID */
  ownerId: string
  title: string
  snippet: string
  /** 资料内定位（如 page=12） */
  locator: string | null
  /** 时间：笔记为学习日期与段落修改时间；资料为发布 / 获取日期 */
  learnedAt: number | null
  updatedAt: number | null
  status: KnowledgeStatus | null
  origin: 'user' | 'ai' | 'ai_reviewed' | null
  /** 怎么找到的（v0.7.6） */
  via?: HitVia
  url?: string
  site?: string | null
  snippetOnly?: boolean
  suspicious?: boolean
  meta?: { authors?: string[]; year?: number; venue?: string; citations?: number; doi?: string; pdfUrl?: string }
}

export interface ChatMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  uiText?: string | null
  reasoning: string | null
  citations: Citation[]
  providerId: string | null
  model: string | null
  effort: Effort | null
  usage: (Usage & { cost: number | null; durationMs: number }) | null
  status: 'streaming' | 'done' | 'error' | 'stopped'
  error: string | null
  /** 本次回答使用的技能 */
  skill: string | null
  steps: AgentStep[]
  /** 用户消息附带了当前页面的数据（v0.6.7） */
  contextual?: boolean
  createdAt: number
}

/* ——— 记忆 ——— */

/**
 * profile：用户预设的个人档案（按 key）；preference：偏好；fact：关于用户的事实；
 * glossary：术语 / 简称；skill：某个技能的输出偏好；episode：学习经历；concept：概念掌握情况
 */
export type MemoryKind = 'profile' | 'preference' | 'fact' | 'glossary' | 'skill' | 'episode' | 'concept'
export const PROFILE_KEYS = ['role', 'goals', 'background', 'style', 'avoid'] as const
export type ProfileKey = (typeof PROFILE_KEYS)[number]
export type UserProfile = Partial<Record<ProfileKey, string>>

export interface Memory {
  id: string
  kind: MemoryKind
  key: string | null
  skill: string | null
  content: string
  sensitive: boolean
  /** pending：等待用户确认（敏感内容） */
  status: 'active' | 'pending' | 'archived'
  pinned: boolean
  origin: 'user' | 'ai'
  evidence: { conversationId?: string; messageId?: string; quote?: string; previous?: string } | null
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  useCount: number
}

/* ——— 复习（FSRS） ——— */

/** 1 忘了 · 2 困难 · 3 记得 · 4 轻松 */
export type ReviewRating = 1 | 2 | 3 | 4

export interface ReviewCard {
  kind: 'cornell' | 'mistake'
  mistakeId: string | null
  variantId: string | null
  original: { question: string; answer: string } | null
  variantFallback: 'empty' | 'no-model' | 'local-only' | 'flagged' | 'unverified' | null
  id: string
  noteId: string
  noteTitle: string
  /** 笔记设为“不给 AI”：不能附带给积微助手 */
  aiExcluded?: boolean
  /** 卡片对应的笔记行 */
  rowId: string
  /** 线索栏（问题） */
  question: string
  /** 笔记栏（答案，Markdown；富内容块为文字形式） */
  answer: string
  state: 'new' | 'learning' | 'review' | 'relearning'
  due: number
  reps: number
  lapses: number
  lastReview: number | null
  /** 各评分对应的下次复习时间（毫秒时间戳） */
  next: Record<ReviewRating, number>
}

/** 卡片库中的一行（v0.7.6）：不加载笔记正文，问题取自线索栏 */
export interface CardListItem {
  id: string
  noteId: string
  /** 卡片对应的笔记行 */
  rowId: string
  noteTitle: string
  categoryId: string | null
  kind: 'cornell' | 'mistake'
  question: string
  state: ReviewCard['state']
  due: number
  reps: number
  lapses: number
  suspended: boolean
  /** 今天到期（含学习中、今天能学的新卡不算） */
  isDue: boolean
}
export type CardFilter = 'all' | 'due' | 'new' | 'learning' | 'review' | 'suspended' | 'weak'

/** 费曼练习首页（v0.7.6） */
export interface FeynmanHome {
  sessions: { id: string; concept: string; noteId: string | null; level: FeynmanReport['level'] | null; updatedAt: number }[]
  suggestions: { concept: string; noteId: string | null; cardId: string | null; reason: 'weak' | 'recent' | 'mistake' }[]
}

export interface ReviewStats {
  /** 现在可以复习的卡片（到期 + 今天还能学的新卡） */
  due: number
  dueReview: number
  newToday: number
  reviewedToday: number
  /** 连续复习天数 */
  streak: number
  /** 近 30 天复习卡片的记住比例（没有数据时为 null） */
  retention: number | null
  total: number
  suspended: number
  /** 明天到期 */
  tomorrow: number
  /** 稍后到期的学习中卡片（分钟内） */
  laterToday: number
}

export interface AnswerCheck {
  /** 一两句总体评价 */
  verdict: string
  /** 遗漏的要点 */
  missing: string[]
  /** 说错或不准确的地方 */
  wrong: string[]
  suggested: ReviewRating
}

/** 学习者模型：某个概念的掌握情况（由行为信号累积，见 docs/design/v0.3-agent.md §5） */
export interface Concept {
  id: string
  name: string
  /** 0～1：<0.35 薄弱，<0.7 学习中，≥0.7 牢固 */
  mastery: number
  level: 'weak' | 'learning' | 'solid'
  /** 请求解释的次数、没听懂的次数、表现出理解的次数 */
  asked: number
  confused: number
  understood: number
  /** 卡点说明（最近一次信号的证据） */
  note: string | null
  firstSeen: number
  lastSeen: number
}

export type ConceptSignal = 'asked' | 'confused' | 'understood'

/** 记忆的个人设置（存于个人数据库，随人不随知识库） */
export interface MemorySettings {
  /** 对话结束后自动整理记忆、学习情况与学习经历 */
  autoLearn: boolean
  /** 从你对 AI 提案的修改与拒绝中学习技能偏好 */
  learnSkills: boolean
}

/** 技能（Agent Skills 标准 SKILL.md） */
export interface SkillInfo {
  name: string
  description: string
  /** 中文显示名（metadata.title） */
  title: string
  source: 'builtin' | 'plugin' | 'user'
  pluginId?: string
  hasScripts?: boolean
  enabled: boolean
  /** 最低模型能力：basic 任何模型；strong 仅强模型 */
  minModel: 'basic' | 'strong'
  /** 适用位置：chat / workspace / selection 等 */
  surfaces: string[]
  path: string
  license: string | null
}

export interface EmbeddingStatus {
  mode: 'local' | 'cloud'
  /** 本地模型：未下载 / 下载中 / 启动中 / 就绪 / 出错；云端：就绪 / 未配置 */
  state: 'missing' | 'downloading' | 'starting' | 'ready' | 'error' | 'unconfigured'
  /** 下载进度 0–1 */
  progress: number
  /** 当前下载来源（镜像） */
  mirror: string | null
  speed: number | null
  message: string | null
  /** 已建立索引 / 总分片数 */
  indexed: number
  total: number
}

export interface SearchHit {
  parentType: 'note' | 'source' | 'web'
  parentId: string
  ownerId: string
  title: string
  text: string
  locator: string | null
  score: number
  /** 余弦相似度（0–1）；向量不可用时不设置，检索排序仍使用 score。 */
  sim?: number
  learnedAt: number | null
  updatedAt: number | null
  status: KnowledgeStatus | null
  origin: 'user' | 'ai' | 'ai_reviewed' | null
  /** 怎么找到的（v0.7.6）：关键词、语义（本地向量）、两者都命中、用户正指着的内容 */
  via?: HitVia
  url?: string
  site?: string | null
  snippetOnly?: boolean
  suspicious?: boolean
  meta?: Citation['meta']
}
export type HitVia = 'keyword' | 'semantic' | 'both' | 'context' | 'web'

/** 语音转写引擎状态 */
export interface AsrStatus {
  state: 'missing' | 'downloading' | 'ready' | 'error'
  progress: number
  mirror: string | null
  speed: number | null
  message: string | null
}

/** 批注（v0.5.3） */
export interface Annotation {
  id: string
  targetType: 'note' | 'source'
  targetId: string
  selector: AnnotationSelector
  motivation: 'highlighting' | 'commenting' | 'questioning' | 'bookmarking' | 'drawing'
  body: string | null
  color: 'yellow' | 'green' | 'blue' | 'pink' | null
  createdAt: number
  updatedAt: number
}

/** 最近的批注（带所在笔记 / 资料的标题），用于复盘与列表 */
export interface AnnotationWithTarget extends Annotation {
  targetTitle: string
}

/** 文档识别引擎（本地模型）状态 */
export interface RecognizerStatus {
  /** 本地模型：未下载 / 下载中 / 已就绪 / 出错 */
  state: 'missing' | 'downloading' | 'ready' | 'error'
  progress: number
  mirror: string | null
  speed: number | null
  message: string | null
  /** 需要下载的总大小（字节，含运行时） */
  size: number
  /** 本地模型是否正在运行（按需加载，空闲后退出） */
  running: boolean
  /** 当前选择的本地模型名称 */
  model?: string
}

/** 一份资料的识别情况 */
export interface SourceRecognition {
  /** 需要识别的页数，按类型 */
  needs: { scan: number; table: number; figure: number }
  /** 本次设置下会处理的页数（插图解读未开启时不含图页） */
  total: number
  done: number
  failed: number
  /** 正在识别（后台任务排队或运行中） */
  running: boolean
  /** 当前设置能否识别：local 需要先下载模型，cloud 需要能看图的模型，off 已关闭，excluded 资料不发送给 AI */
  engine: 'ready' | 'needs-install' | 'no-vision-model' | 'off' | 'excluded'
}

/** 主进程 → 渲染进程的事件 */
export interface JiweiEvents {
  'mail:changed': Record<string, never>
  'discover:changed': Record<string, never>
  'retrieval:changed': Record<string, never>
  'lenses:changed': { sourceId: string }
  'series:changed': undefined
  'recording:changed': { id: string }
  'recording:open': undefined
  'voiceprint:status': import('./recording').VoiceStatus
  'people:changed': undefined
  'sources:changed': { id: string }
  'capture:prepare': { id: string }
  'capture:deliver': import('./capture').CaptureDelivery
  'capture:changed': import('./capture').CaptureState
  'capture:release': { id: string }
  /** 应用即将退出 / 重载：请立即保存未写入的内容，然后调用 app.flushDone() */
  'app:flush': void
  /** 笔记派生数据（标题、字数、段落）已更新 */
  'notes:changed': { ids: string[] }
  /** 提案新增或处理 */
  'proposals:changed': { noteId: string }
  /** 后台任务状态变化 */
  'jobs:changed': { ids: string[] }
  /** 复习卡片或到期数量变化 */
  'review:changed': Record<string, never>
  'plan:changed': Record<string, never>
  /** 参谋与决策日志变化（v0.9） */
  'advisor:changed': Record<string, never>
  /** 创作工坊作品变化（v0.9） */
  'works:changed': Record<string, never>
  'tasks:changed': Record<string, never>
  'tasks:run': { taskId: string; runId: string; status: import('./tasks').TaskRun['status'] }
  'nav:tasks': { taskId: string }
  /** 资料分段已更新 */
  'segments:changed': { sourceId: string }
  /** 文档识别引擎状态 */
  'recognition:status': RecognizerStatus
  /** 内置浏览器：标签页状态 */
  'browser:state': BrowserState
  /** 内置浏览器：网页中选区浮条的操作 */
  'browser:action': BrowserAction
  /** 内置浏览器：打开网页时找到的相关笔记 */
  'browser:related': BrowserRelated
  /** 内置浏览器：焦点在网页中时按下的积微快捷键 */
  'browser:shortcut': { key: string; shift: boolean }
  /** 内置浏览器：下载完成并导入资料库 */
  'browser:download': { name: string; sourceId: string | null; path: string }
  'course:event': { tabId: string; kind: 'ended' | 'slide' | 'error'; message?: string }
  /** 某个笔记 / 资料的批注变化 */
  'annotations:changed': { targetType: 'note' | 'source'; targetId: string }
  /** 某份资料的识别进度 */
  'recognition:source': { sourceId: string }
  /** AI 回答的流式增量 */
  'chat:delta': { messageId: string; conversationId: string; text?: string; reasoning?: string }
  /** AI 回答完成 / 出错 / 停止（携带完整消息） */
  'chat:done': { message: ChatMessage }
  /** AI 执行步骤更新 */
  'chat:step': { messageId: string; conversationId: string; step: AgentStep }
  /** 向量模型与索引状态 */
  'embedding:status': EmbeddingStatus
  /** 语音转写引擎状态 */
  'asr:status': AsrStatus
  /** 本机语音合成模型的下载状态 */
  'speech:status': import('./discover').LocalSpeechStatus
  'moss:status': import('./moss').MossStatus
  /** 记忆变化；added 为 AI 新记住的内容（界面提示，可撤销 / 确认） */
  'memory:changed': { added?: Memory; learned?: Memory[] }
  /** 深层链接：jiwei://note/<id> 或 jiwei://source/<id> */
  'inbox:changed': Record<string, never>
  /** 内置浏览器里有操作或开始 / 停止播放（v0.6.7 活动记录） */
  'activity:pulse': { source: 'browser'; playing: boolean | null }
  /** v0.7 智能体底座：记账变化、等待确认、确认已处理、审计新增、MCP 状态变化 */
  'usage:changed': Record<string, never>
  /** 花费接近上限（v0.7.5）：spent、limit 为美元 */
  /** 主进程改了设置（如后台更新汇率），界面重新读取（v0.7.5） */
  'settings:changed': Record<string, never>
  /** 整份资料的导图 / 总结 / 提纲已作为提案放进笔记（v0.7.6） */
  'digest:done': { noteId: string; title: string; task: 'mindmap' | 'summary' | 'outline' }
  'usage:alert': { kind: 'daily' | 'monthly'; spent: number; limit: number }
  'agent:approval': import('./agent').ApprovalRequest
  'agent:approval-done': { id: string; messageId: string; allow: boolean }
  'agent:audit': Record<string, never>
  'mcp:changed': Record<string, never>
  'plugins:changed': Record<string, never>
  'plugins:progress': { id: string; phase: 'download' | 'verify' | 'install'; received?: number; total?: number }
  'mistakes:changed': Record<string, never>
  'mistakes:open': Record<string, never>
  'reading:word': import('./reading').ReadingWord
  'nav:inbox': Record<string, never>
  'docs:updated': { noteId: string; update: Uint8Array }
  'nav:open': { type: 'note' | 'source'; id: string }
  /** 打开助手中的某个对话（系统通知点击，v0.7） */
  'nav:chat': { conversationId: string }
  /** 复盘提醒被点击：打开复盘页 */
  'nav:reflect': { kind: 'daily' | 'weekly' }
  /** 复盘、洞见或行动项变化 */
  'reflection:changed': Record<string, never>
  'updates:changed': import('./updates').UpdateState
  'importer:changed': Record<string, never>
}

/** 本地 grounding 识别结果；保留版面块供公式与扫描文字层使用。 */
export interface RegionRecognition {
  text: string
  blocks: import('./scanText').ScanBlock[]
  engine: string
}
export interface ScanPageText {
  page: number
  blocks: import('./scanText').ScanBlock[]
}
