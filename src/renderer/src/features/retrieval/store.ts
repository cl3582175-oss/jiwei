import { create } from 'zustand'
import type { WebOrigin } from '@shared/retrieval'

interface WebSnapshotState {
  pageId: string | null
  locator: string | null
  /** 快照清理后仍可从引用打开原网页；仅用于界面，不持久化。 */
  url: string | null
  webOrigin?: WebOrigin
  open: (pageId: string, locator: string | null, url?: string, webOrigin?: WebOrigin) => void
  close: () => void
}

export const useWebSnapshot = create<WebSnapshotState>((set) => ({
  pageId: null,
  locator: null,
  url: null,
  open: (pageId, locator, url, webOrigin) => set({ pageId, locator, url: url ?? null, webOrigin }),
  close: () => set({ pageId: null, locator: null, url: null, webOrigin: undefined })
}))
