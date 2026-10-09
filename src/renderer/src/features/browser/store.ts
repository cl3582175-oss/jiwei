import { create } from 'zustand'
import type { BrowserRelated, BrowserState, BrowserTab } from '@shared/types'
import { api } from '@/lib/utils'

// 内置浏览器的界面状态（v0.6.0）：标签页由主进程管理，这里只同步显示；另有相关笔记旁注与暂停时的截图。

interface State {
  state: BrowserState
  related: Record<string, BrowserRelated>
  /** 弹出层盖住网页时显示的截图 */
  frozen: string | null
  setFrozen: (img: string | null) => void
}

export const useBrowser = create<State>((set) => ({
  state: { tabs: [], activeId: null },
  related: {},
  frozen: null,
  setFrozen: (frozen) => set({ frozen })
}))

let wired = false
/** 订阅主进程的浏览器事件（应用启动时调用一次） */
export function wireBrowserEvents(): void {
  if (wired) return
  wired = true
  void api.browser.state().then((state) => useBrowser.setState({ state }))
  window.jiweiEvents.on('browser:state', (state) => useBrowser.setState({ state }))
  window.jiweiEvents.on('browser:related', (r) => useBrowser.setState((s) => ({ related: { ...s.related, [r.tabId]: r } })))
}

export const activeTab = (s: State): BrowserTab | null => s.state.tabs.find((t) => t.id === s.state.activeId) ?? null
/** 当前标签页是否允许 AI（非敏感、非无痕、是网页） */
export const aiAllowed = (t: BrowserTab | null): t is BrowserTab => !!t && !t.sensitive && !t.incognito && /^https?:/i.test(t.url)
