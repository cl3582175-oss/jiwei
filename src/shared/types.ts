// 主进程与渲染进程共享的数据类型（输出类型）。
// 输入类型由 zod 模式推导（schemas.ts），API 由能力注册表推导（capabilities.ts）。

import type {
  AiSettings,
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
import type { Effort, ProviderKind, Usage } from './ai'
export type {
  AiSettings,
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

export type SourceKind = 'book' | 'pdf' | 'video' | 'audio' | 'image' | 'document' | 'web' | 'other'

export interface Source {
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

export type TrashType = 'note' | 'source' | 'category'

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

export interface Settings {
  language: Language
  theme: ThemeMode
  palette: Palette
  reflection: ReflectionSettings
  /** 是否已完成首次启动引导 */
  onboarded: boolean
  /** 侧栏（目录 / 资料分类）是否收起 */
  sidebarCollapsed: boolean
  ai: AiSettings
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
  kind: 'auto' | 'pre-migrate'
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
  id: string
  kind: ProviderKind
  name: string
  baseUrl: string
  hasKey: boolean
  /** API Key 末四位提示（明文永不离开主进程） */
  keyHint: string | null
  models: string[]
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
  pinned: boolean
  createdAt: number
  updatedAt: number
}

/** 回答引用的知识库片段 */
export interface Citation {
  /** 回答中的引用编号 [n] */
  n: number
  parentType: 'note' | 'source'
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
}

export interface ChatMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string | null
  citations: Citation[]
  providerId: string | null
  model: string | null
  effort: Effort | null
  usage: (Usage & { cost: number | null; durationMs: number }) | null
  status: 'streaming' | 'done' | 'error' | 'stopped'
  error: string | null
  createdAt: number
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
  parentType: 'note' | 'source'
  parentId: string
  ownerId: string
  title: string
  text: string
  locator: string | null
  score: number
  learnedAt: number | null
  updatedAt: number | null
  status: KnowledgeStatus | null
  origin: 'user' | 'ai' | 'ai_reviewed' | null
}

/** 主进程 → 渲染进程的事件 */
export interface JiweiEvents {
  /** 应用即将退出 / 重载：请立即保存未写入的内容，然后调用 app.flushDone() */
  'app:flush': void
  /** 笔记派生数据（标题、字数、段落）已更新 */
  'notes:changed': { ids: string[] }
  /** 提案新增或处理 */
  'proposals:changed': { noteId: string }
  /** 后台任务状态变化 */
  'jobs:changed': { ids: string[] }
  /** 资料分段已更新 */
  'segments:changed': { sourceId: string }
  /** AI 回答的流式增量 */
  'chat:delta': { messageId: string; conversationId: string; text?: string; reasoning?: string }
  /** AI 回答完成 / 出错 / 停止（携带完整消息） */
  'chat:done': { message: ChatMessage }
  /** 向量模型与索引状态 */
  'embedding:status': EmbeddingStatus
  /** 深层链接：jiwei://note/<id> 或 jiwei://source/<id> */
  'nav:open': { type: 'note' | 'source'; id: string }
}
