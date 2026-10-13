import { create } from 'zustand'
import type { SourceKind } from '@shared/types'
import type { Scene } from '@shared/recording'
export type CatFilter = { type: 'all' } | { type: 'uncategorized' } | { type: 'category'; id: string }
interface LibraryState {
  kind?: SourceKind
  cat: CatFilter
  search: string
  scene?: Scene
  seriesId: string
  scrollTop: number
  selectedId: string | null
}
export const useLibraryState = create<LibraryState>(() => ({
  cat: { type: 'all' },
  search: '',
  seriesId: '',
  scrollTop: 0,
  selectedId: null
}))
export function setLibraryFilter(patch: Partial<LibraryState>): void {
  useLibraryState.setState({ ...patch, scrollTop: 0, selectedId: null })
}
