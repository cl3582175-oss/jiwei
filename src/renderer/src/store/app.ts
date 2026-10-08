import { create } from 'zustand'
import type { NoteSort, WorkspaceContext } from '@shared/types'

export type View = 'notes' | 'library' | 'trash'

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

  noteFilter: NoteFilter
  setNoteFilter: (f: NoteFilter) => void
  noteSort: NoteSort
  setNoteSort: (s: NoteSort) => void
  settingsOpen: boolean
  setSettingsOpen: (o: boolean) => void
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

    noteFilter: { type: 'all' },
    setNoteFilter: (noteFilter) => set({ noteFilter }),
    noteSort: 'edited',
    setNoteSort: (noteSort) => set({ noteSort }),
    settingsOpen: false,
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    paletteOpen: false,
    setPaletteOpen: (paletteOpen) => set({ paletteOpen })
  }
})

/** 读取当前工作区上下文（AI 请求时随附） */
export const getWorkspaceContext = (): WorkspaceContext => useApp.getState().context
