// 主进程与渲染进程共享的数据类型与 API 契约。
// 新增 IPC 能力时：先在 JiweiAPI 中声明，再在 main/ipc.ts 中实现，preload 会自动转发。

/** Tiptap / ProseMirror 文档 JSON */
export type DocJSON = { type: string; content?: DocNode[] }
export type DocNode = { type?: string; attrs?: Record<string, unknown>; content?: DocNode[]; marks?: { type: string; attrs?: Record<string, unknown> }[]; text?: string; [key: string]: unknown }

export type CategoryKind = 'note' | 'source'

export interface Category {
  id: string
  name: string
  kind: CategoryKind
  sortOrder: number
  createdAt: number
}

export interface NoteSummary {
  id: string
  title: string
  categoryId: string | null
  pinned: boolean
  excerpt: string
  wordCount: number
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

/** 康奈尔笔记：线索栏(cue) + 笔记栏(content) + 总结栏(summary) */
export interface Note extends NoteSummary {
  cue: DocJSON
  content: DocJSON
  summary: DocJSON
}

export interface NoteUpdate {
  title?: string
  categoryId?: string | null
  pinned?: boolean
  cue?: DocJSON
  content?: DocJSON
  summary?: DocJSON
  /** 渲染进程提取的纯文本，用于全文检索与字数统计 */
  plainText?: string
}

export type NoteSort = 'updated' | 'created' | 'title'

export interface NoteQuery {
  categoryId?: string | null
  pinnedOnly?: boolean
  search?: string
  sort?: NoteSort
}

export type SourceKind = 'book' | 'pdf' | 'video' | 'audio' | 'image' | 'document' | 'web' | 'other'

export interface Source {
  id: string
  title: string
  kind: SourceKind
  originalName: string | null
  mime: string | null
  size: number
  url: string | null
  categoryId: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

export interface SourceQuery {
  categoryId?: string | null
  kind?: SourceKind
  search?: string
}

export interface TrashItem {
  type: 'note' | 'source'
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

export interface Settings {
  language: Language
  theme: ThemeMode
  accent: string
}

export interface AppInfo {
  version: string
  dataDir: string
  platform: NodeJS.Platform
}

export const TRASH_RETENTION_DAYS = 30

export interface JiweiAPI {
  app: {
    info(): Promise<AppInfo>
    openDataDir(): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  categories: {
    list(kind: CategoryKind): Promise<Category[]>
    create(kind: CategoryKind, name: string): Promise<Category>
    rename(id: string, name: string): Promise<void>
    remove(id: string): Promise<void>
  }
  notes: {
    list(query: NoteQuery): Promise<NoteSummary[]>
    get(id: string): Promise<Note | null>
    create(init?: { categoryId?: string | null; title?: string }): Promise<Note>
    update(id: string, patch: NoteUpdate): Promise<NoteSummary>
    trash(id: string): Promise<void>
  }
  sources: {
    list(query: SourceQuery): Promise<Source[]>
    /** 打开系统文件选择框导入；返回新导入的资料 */
    importDialog(categoryId?: string | null): Promise<Source[]>
    /** 通过绝对路径导入（拖拽） */
    importPaths(paths: string[], categoryId?: string | null): Promise<Source[]>
    addUrl(url: string, title?: string, categoryId?: string | null): Promise<Source>
    update(id: string, patch: { title?: string; categoryId?: string | null }): Promise<void>
    open(id: string): Promise<void>
    reveal(id: string): Promise<void>
    trash(id: string): Promise<void>
  }
  trash: {
    list(): Promise<TrashItem[]>
    restore(type: TrashItem['type'], id: string): Promise<void>
    purge(type: TrashItem['type'], id: string): Promise<void>
    empty(): Promise<void>
  }
  stats: {
    heatmap(days: number): Promise<HeatmapDay[]>
  }
}

type ApiMethods = {
  [NS in keyof JiweiAPI]: { [M in keyof JiweiAPI[NS]]: `${NS & string}:${M & string}` }[keyof JiweiAPI[NS]]
}
export type IpcChannel = ApiMethods[keyof ApiMethods]

/** 所有 IPC 通道名，preload 据此生成桥接对象 */
export const API_SHAPE: { [NS in keyof JiweiAPI]: (keyof JiweiAPI[NS])[] } = {
  app: ['info', 'openDataDir'],
  settings: ['get', 'set'],
  categories: ['list', 'create', 'rename', 'remove'],
  notes: ['list', 'get', 'create', 'update', 'trash'],
  sources: ['list', 'importDialog', 'importPaths', 'addUrl', 'update', 'open', 'reveal', 'trash'],
  trash: ['list', 'restore', 'purge', 'empty'],
  stats: ['heatmap']
}
