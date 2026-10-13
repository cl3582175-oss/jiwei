import { create } from 'zustand'

interface WebSnapshotState {
  pageId: string | null
  locator: string | null
  /** 快照清理后仍可从引用打开原网页；仅用于界面，不持久化。 */
  url: string | null
  open: (pageId: string, locator: string | null, url?: string) => void
  close: () => void
}

export const useWebSnapshot = create<WebSnapshotState>((set) => ({
  pageId: null,
  locator: null,
  url: null,
  open: (pageId, locator, url) => set({ pageId, locator, url: url ?? null }),
  close: () => set({ pageId: null, locator: null, url: null })
}))
