import { create } from 'zustand'
import type { NoteSort } from '@shared/types'

export type View = 'notes' | 'library' | 'trash'

/** 笔记列表筛选：全部 / 置顶 / 未分类 / 某分类 */
export type NoteFilter =
  | { type: 'all' }
  | { type: 'pinned' }
  | { type: 'uncategorized' }
  | { type: 'category'; id: string }
  | { type: 'tag'; id: string }

interface AppState {
  view: View
  setView: (v: View) => void
  activeNoteId: string | null
  openNote: (id: string | null) => void
  noteFilter: NoteFilter
  setNoteFilter: (f: NoteFilter) => void
  noteSort: NoteSort
  setNoteSort: (s: NoteSort) => void
  settingsOpen: boolean
  setSettingsOpen: (o: boolean) => void
  paletteOpen: boolean
  setPaletteOpen: (o: boolean) => void
}

export const useApp = create<AppState>((set) => ({
  view: 'notes',
  setView: (view) => set({ view }),
  activeNoteId: null,
  openNote: (activeNoteId) => set({ activeNoteId, view: 'notes' }),
  noteFilter: { type: 'all' },
  setNoteFilter: (noteFilter) => set({ noteFilter }),
  noteSort: 'edited',
  setNoteSort: (noteSort) => set({ noteSort }),
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen })
}))
