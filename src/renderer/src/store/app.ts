import { create } from 'zustand'
import type { NoteSort, WorkspaceContext } from '@shared/types'

export type View = 'notes' | 'library' | 'chat' | 'review' | 'reflect' | 'feynman' | 'trash'

/** 笔记列表筛选：全部 / 置顶 / 未分类 / 某分类 / 某标签 */
export type NoteFilter =
  { type: 'all' } | { type: 'pinned' } | { type: 'uncategorized' } | { type: 'category'; id: string } | { type: 'tag'; id: string }

/** 导航位置：前进 / 后退的单位 */
export interface Location {
  view: View
  noteId: string | null
  sourceId: string | null
}

const HISTORY_MAX = 100

const emptyContext: WorkspaceContext = {
  noteId: null,
  cursorBlockId: null,
  cursorRowId: null,
  noteSelection: null,
  sourceId: null,
  sourceLocator: null,
  sourceSelection: null,
  sourceSegmentId: null
}

interface AppState extends Location {
  /** 导航到新位置（记入历史） */
  navigate: (to: Partial<Location>) => void
  back: () => void
  forward: () => void
  history: Location[]
  historyIndex: number

  setView: (v: View) => void
  openNote: (id: string | null) => void
  /** 在工作区左侧打开资料（null 关闭） */
  openSource: (id: string | null) => void

  /** 工作区分栏比例（资料栏百分比） */
  sourcePaneSize: number
  setSourcePaneSize: (n: number) => void

  context: WorkspaceContext
  setContext: (patch: Partial<WorkspaceContext>) => void

  /** 复习页的标签：今日复习 / 掌握度地图 / 学习目标 */
  reviewTab: 'today' | 'mastery' | 'goals'
  setReviewTab: (t: 'today' | 'mastery' | 'goals') => void

  /** 复盘页中打开的复盘（null 为复盘首页） */
  reflectionId: string | null
  openReflection: (id: string | null) => void

  /** 当前的费曼练习：conversationId 为 null 表示还没开始讲 */
  feynman: { conversationId: string | null; concept: string; noteId: string | null; cardId: string | null } | null
  /** 开始（或继续）一次费曼练习 */
  startFeynman: (f: { concept: string; noteId?: string | null; cardId?: string | null; conversationId?: string | null }) => void
  setFeynmanConversation: (id: string) => void

  /** 当前 AI 对话（null 为新对话） */
  conversationId: string | null
  openConversation: (id: string | null) => void
  /** 打开笔记 / 资料后需要定位并高亮的段落（来自 AI 引用） */
  highlight: { type: 'block' | 'segment'; id: string; locator?: string | null } | null
  setHighlight: (h: AppState['highlight']) => void

  noteFilter: NoteFilter
  setNoteFilter: (f: NoteFilter) => void
  noteSort: NoteSort
  setNoteSort: (s: NoteSort) => void
  settingsOpen: boolean
  setSettingsOpen: (o: boolean) => void
  /** 打开设置时定位的标签页 */
  settingsTab: string | null
  openSettings: (tab?: string) => void
  paletteOpen: boolean
  setPaletteOpen: (o: boolean) => void
}

const same = (a: Location, b: Location): boolean => a.view === b.view && a.noteId === b.noteId && a.sourceId === b.sourceId

export const useApp = create<AppState>((set, get) => {
  const apply = (loc: Location): void =>
    set((s) => ({
      ...loc,
      context: {
        ...s.context,
        noteId: loc.noteId,
        sourceId: loc.sourceId,
        ...(loc.sourceId !== s.sourceId ? { sourceLocator: null, sourceSelection: null, sourceSegmentId: null } : {})
      }
    }))

  return {
    view: 'notes',
    noteId: null,
    sourceId: null,
    history: [{ view: 'notes', noteId: null, sourceId: null }],
    historyIndex: 0,

    navigate: (to) => {
      const s = get()
      const next: Location = {
        view: to.view ?? s.view,
        noteId: to.noteId !== undefined ? to.noteId : s.noteId,
        sourceId: to.sourceId !== undefined ? to.sourceId : s.sourceId
      }
      const cur = s.history[s.historyIndex]
      if (cur && same(cur, next)) return apply(next)
      const history = [...s.history.slice(0, s.historyIndex + 1), next].slice(-HISTORY_MAX)
      set({ history, historyIndex: history.length - 1 })
      apply(next)
    },
    back: () => {
      const { historyIndex, history } = get()
      if (historyIndex <= 0) return
      set({ historyIndex: historyIndex - 1 })
      apply(history[historyIndex - 1])
    },
    forward: () => {
      const { historyIndex, history } = get()
      if (historyIndex >= history.length - 1) return
      set({ historyIndex: historyIndex + 1 })
      apply(history[historyIndex + 1])
    },

    setView: (view) => get().navigate({ view }),
    openNote: (noteId) => get().navigate({ view: 'notes', noteId }),
    openSource: (sourceId) => get().navigate({ view: 'notes', sourceId }),

    sourcePaneSize: 38.2,
    setSourcePaneSize: (sourcePaneSize) => set({ sourcePaneSize }),

    context: emptyContext,
    setContext: (patch) => set((s) => ({ context: { ...s.context, ...patch } })),

    reviewTab: 'today',
    setReviewTab: (reviewTab) => set({ reviewTab }),

    reflectionId: null,
    openReflection: (reflectionId) => {
      set({ reflectionId })
      get().navigate({ view: 'reflect' })
    },

    feynman: null,
    startFeynman: (f) => {
      set({
        feynman: { conversationId: f.conversationId ?? null, concept: f.concept.trim(), noteId: f.noteId ?? null, cardId: f.cardId ?? null }
      })
      get().navigate({ view: 'feynman' })
    },
    setFeynmanConversation: (id) => set((s) => (s.feynman ? { feynman: { ...s.feynman, conversationId: id } } : {})),

    conversationId: null,
    openConversation: (conversationId) => {
      set({ conversationId })
      get().navigate({ view: 'chat' })
    },
    highlight: null,
    setHighlight: (highlight) => set({ highlight }),

    noteFilter: { type: 'all' },
    setNoteFilter: (noteFilter) => set({ noteFilter }),
    noteSort: 'edited',
    setNoteSort: (noteSort) => set({ noteSort }),
    settingsOpen: false,
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    settingsTab: null,
    openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab ?? null }),
    paletteOpen: false,
    setPaletteOpen: (paletteOpen) => set({ paletteOpen })
  }
})

/** 读取当前工作区上下文（AI 请求时随附） */
export const getWorkspaceContext = (): WorkspaceContext => useApp.getState().context

/**
 * 打开资料并定位：seg 片段、page 页码、t 秒（出处链接 jiwei://source/<id>?seg=&page=&t=）。
 * 定位信息通过 highlight 交给资料面板处理。
 */
export function openSourceAt(id: string, q: URLSearchParams): void {
  const s = useApp.getState()
  const seg = q.get('seg')
  const locator = q.get('t') ? `t=${q.get('t')}` : q.get('page') ? `page=${q.get('page')}` : null
  if (seg || locator) s.setHighlight({ type: 'segment', id: seg ?? '', locator })
  s.openSource(id)
}
