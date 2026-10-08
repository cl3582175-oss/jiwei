// 主进程与渲染进程共享的数据类型与 API 契约。
// 新增 IPC 能力时：先在 JiweiAPI 中声明并加入 API_SHAPE，再在 main/ipc.ts 中实现，preload 会自动转发。

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

/** 文档格式版本：编辑器结构变化时递增，并在 main/services/docs.ts 中提供升级逻辑 */
export const DOC_VERSION = 1
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
  categoryId: string | null
  pinned: boolean
  learnedAt: number
  status: KnowledgeStatus
  supersededBy: string | null
  aiExcluded: boolean
  tagIds: string[]
  excerpt: string
  wordCount: number
  createdAt: number
  /** 正文最后修改时间 */
  editedAt: number
  updatedAt: number
  deletedAt: number | null
}

export type Note = NoteSummary

export interface NoteMetaUpdate {
  title?: string
  categoryId?: string | null
  pinned?: boolean
  learnedAt?: number
  status?: KnowledgeStatus
  supersededBy?: string | null
  aiExcluded?: boolean
}

export type NoteSort = 'edited' | 'created' | 'learned' | 'title'

export interface NoteQuery {
  categoryId?: string | null
  /** 包含子分类中的笔记 */
  includeDescendants?: boolean
  tagId?: string
  pinnedOnly?: boolean
  status?: KnowledgeStatus
  search?: string
  sort?: NoteSort
  limit?: number
}

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
  createdAt: number
  updatedAt: number
}

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

export interface SourceUpdate {
  title?: string
  categoryId?: string | null
  author?: string | null
  publishedAt?: number | null
  aiExcluded?: boolean
}

export interface SourceQuery {
  categoryId?: string | null
  includeDescendants?: boolean
  kind?: SourceKind
  tagId?: string
  search?: string
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

export interface Settings {
  language: Language
  theme: ThemeMode
  accent: string
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

export interface JiweiAPI {
  app: {
    info(): Promise<AppInfo>
    openDataDir(): Promise<void>
    /** 选择新的数据目录：复制数据后重启应用；取消返回 false */
    changeDataDir(): Promise<boolean>
    /** 渲染进程完成保存后回复主进程（响应 app:flush 事件） */
    flushDone(): Promise<void>
  }
  backups: {
    list(): Promise<BackupInfo[]>
    create(): Promise<BackupInfo>
    reveal(): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  categories: {
    list(kind: CategoryKind): Promise<Category[]>
    create(kind: CategoryKind, name: string, parentId?: string | null): Promise<Category>
    update(id: string, patch: { name?: string; parentId?: string | null; color?: string | null }): Promise<void>
    /** 移入最近删除（含子分类）；其中的内容视为未分类 */
    remove(id: string): Promise<void>
  }
  tags: {
    list(): Promise<Tag[]>
    /** 按名称获取或创建 */
    ensure(name: string): Promise<Tag>
    rename(id: string, name: string): Promise<void>
    remove(id: string): Promise<void>
    set(entityType: 'note' | 'source', entityId: string, tagIds: string[]): Promise<void>
  }
  notes: {
    list(query: NoteQuery): Promise<NoteSummary[]>
    get(id: string): Promise<Note | null>
    create(init?: { categoryId?: string | null; title?: string }): Promise<Note>
    update(id: string, patch: NoteMetaUpdate): Promise<NoteSummary>
    trash(id: string): Promise<void>
    /** 读取 Yjs 文档完整状态 */
    loadDoc(id: string): Promise<Uint8Array>
    /** 追加 Yjs 增量更新 */
    pushUpdate(id: string, update: Uint8Array): Promise<void>
    blocks(id: string): Promise<BlockInfo[]>
  }
  revisions: {
    list(noteId: string): Promise<RevisionInfo[]>
    get(id: string): Promise<Revision | null>
    /** 手动保存一个版本（restore 表示恢复旧版本前的自动存档） */
    create(noteId: string, reason?: 'manual' | 'restore'): Promise<RevisionInfo>
  }
  assets: {
    importBytes(name: string, mime: string, bytes: Uint8Array): Promise<AssetRef>
  }
  sources: {
    list(query: SourceQuery): Promise<Source[]>
    importDialog(categoryId?: string | null): Promise<ImportResult>
    importPaths(paths: string[], categoryId?: string | null): Promise<ImportResult>
    addUrl(url: string, title?: string, categoryId?: string | null): Promise<Source>
    update(id: string, patch: SourceUpdate): Promise<void>
    open(id: string): Promise<void>
    reveal(id: string): Promise<void>
    trash(id: string): Promise<void>
  }
  trash: {
    list(): Promise<TrashItem[]>
    restore(type: TrashType, id: string): Promise<void>
    purge(type: TrashType, id: string): Promise<void>
    empty(): Promise<void>
  }
  stats: {
    heatmap(days: number): Promise<HeatmapDay[]>
  }
}

/** 主进程 → 渲染进程的事件 */
export interface JiweiEvents {
  /** 应用即将退出 / 重载：请立即保存未写入的内容，然后调用 app.flushDone() */
  'app:flush': void
  /** 笔记派生数据（标题、字数、段落）已更新 */
  'notes:changed': { ids: string[] }
}

/** 所有 IPC 通道名，preload 据此生成桥接对象 */
export const API_SHAPE: { [NS in keyof JiweiAPI]: (keyof JiweiAPI[NS])[] } = {
  app: ['info', 'openDataDir', 'changeDataDir', 'flushDone'],
  backups: ['list', 'create', 'reveal'],
  settings: ['get', 'set'],
  categories: ['list', 'create', 'update', 'remove'],
  tags: ['list', 'ensure', 'rename', 'remove', 'set'],
  notes: ['list', 'get', 'create', 'update', 'trash', 'loadDoc', 'pushUpdate', 'blocks'],
  revisions: ['list', 'get', 'create'],
  assets: ['importBytes'],
  sources: ['list', 'importDialog', 'importPaths', 'addUrl', 'update', 'open', 'reveal', 'trash'],
  trash: ['list', 'restore', 'purge', 'empty'],
  stats: ['heatmap']
}
