import { create } from 'zustand'
import { useApp } from '../../store/app'
import type { Anchor } from '@shared/context'

// 阅读辅助的界面状态：选区浮条、就地答复卡片、工作区 AI 面板。

export type AskAction = 'explain' | 'clarify' | 'translate' | 'grammar' | 'ask' | ReviseAction
/** 修改笔记的快捷操作 */
export type ReviseAction = 'shorten' | 'expand' | 'simplify' | 'fix' | 'list' | 'revise' | 'remap'
export const REVISE_ACTIONS: ReviseAction[] = ['shorten', 'expand', 'simplify', 'fix', 'list']
export const isRevise = (a: AskAction): a is ReviseAction => a === 'revise' || a === 'remap' || (REVISE_ACTIONS as string[]).includes(a)

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface CardState {
  /** 每次打开一张新卡片都换 key，避免旧流式内容串到新卡片 */
  key: string
  anchor: Anchor
  rect: Rect
  action: AskAction
  /** 已发送后的会话（就地提问） */
  conversationId: string | null
  /** 首个问题（用于“存入笔记”的线索） */
  question: string
  /** 框选区域 / 视频画面的截图（PNG data URL） */
  image?: string
  /** 同时指向的其他块（笔记中跨段落选区） */
  extra?: Anchor[]
}

export interface PanelState {
  open: boolean
  pinned: boolean
  conversationId: string | null
  draft: string | null
  autoSend: boolean
}
type PanelPatch = Partial<{
  panelOpen: boolean
  panelPinned: boolean
  panelConversationId: string | null
  panelDraft: string | null
  panelAutoSend: boolean
}>
const EMPTY_PANEL: PanelState = Object.freeze({ open: false, pinned: false, conversationId: null, draft: null, autoSend: false })
const pageOf = (s: { view: string; browserOpen: boolean }): string => (s.view === 'notes' && s.browserOpen ? 'browser' : s.view)
export const currentPanelPage = (): string => pageOf(useApp.getState())
export const usePanelPage = (): string => useApp(pageOf)
function panelPatch(p: PanelPatch): Partial<PanelState> {
  return {
    ...(p.panelOpen !== undefined ? { open: p.panelOpen } : {}),
    ...(p.panelPinned !== undefined ? { pinned: p.panelPinned } : {}),
    ...(p.panelConversationId !== undefined ? { conversationId: p.panelConversationId } : {}),
    ...(p.panelDraft !== undefined ? { draft: p.panelDraft } : {}),
    ...(p.panelAutoSend !== undefined ? { autoSend: p.panelAutoSend } : {})
  }
}

interface AssistState {
  /** rects：PDF 选区在页内的相对矩形（跨行时多个），用于高亮批注 */
  toolbar: { anchor: Anchor; rect: Rect; rects?: Rect[]; restricted?: boolean; text?: string } | null
  showToolbar: (t: AssistState['toolbar']) => void
  card: CardState | null
  openCard: (c: Omit<CardState, 'key'>) => void
  updateCard: (patch: Partial<CardState>) => void
  closeCard: () => void

  replyQuotes: Record<string, string>
  setReplyQuote: (id: string, text: string | null) => void
  panels: Record<string, PanelState>
  setPanel: (patch: PanelPatch, page?: string) => void
}

export const useAssist = create<AssistState>((set) => ({
  toolbar: null,
  showToolbar: (toolbar) => set({ toolbar }),
  card: null,
  openCard: (c) => set({ card: { ...c, key: crypto.randomUUID() }, toolbar: null }),
  updateCard: (patch) => set((s) => (s.card ? { card: { ...s.card, ...patch } } : {})),
  closeCard: () => set({ card: null }),

  replyQuotes: {},
  setReplyQuote: (id, text) =>
    set((s) => {
      const replyQuotes = { ...s.replyQuotes }
      if (text === null) delete replyQuotes[id]
      else replyQuotes[id] = text
      return { replyQuotes }
    }),
  panels: {},
  setPanel: (patch, page = currentPanelPage()) =>
    set((s) => ({
      panels: { ...s.panels, [page]: { ...(s.panels[page] ?? EMPTY_PANEL), ...panelPatch(patch) } }
    }))
}))

export function getPanel(page = currentPanelPage()): PanelState {
  return useAssist.getState().panels[page] ?? EMPTY_PANEL
}
export function usePanel(): PanelState {
  const page = usePanelPage()
  return useAssist((s) => s.panels[page] ?? EMPTY_PANEL)
}
// Includes browser/notes switches and back/forward navigation, without coupling App navigation to overlays.
useApp.subscribe((next, previous) => {
  if (pageOf(next) !== pageOf(previous)) useAssist.setState({ toolbar: null, card: null })
})

/** 选区（Range）在视口中的位置 */
export function rangeRect(r: Range): Rect {
  const b = r.getBoundingClientRect()
  return { x: b.left, y: b.top, w: b.width, h: b.height }
}

export function elementRect(el: Element): Rect {
  const b = el.getBoundingClientRect()
  return { x: b.left, y: b.top, w: b.width, h: b.height }
}
