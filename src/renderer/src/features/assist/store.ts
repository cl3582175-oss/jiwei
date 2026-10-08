import { create } from 'zustand'
import type { Anchor } from '@shared/context'

// 阅读辅助的界面状态：选区浮条、就地答复卡片、工作区 AI 面板。

export type AskAction = 'explain' | 'clarify' | 'translate' | 'ask'

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
}

interface AssistState {
  toolbar: { anchor: Anchor; rect: Rect } | null
  showToolbar: (t: AssistState['toolbar']) => void
  card: CardState | null
  openCard: (c: Omit<CardState, 'key'>) => void
  updateCard: (patch: Partial<CardState>) => void
  closeCard: () => void

  panelOpen: boolean
  panelPinned: boolean
  panelConversationId: string | null
  setPanel: (p: Partial<Pick<AssistState, 'panelOpen' | 'panelPinned' | 'panelConversationId'>>) => void
}

export const useAssist = create<AssistState>((set) => ({
  toolbar: null,
  showToolbar: (toolbar) => set({ toolbar }),
  card: null,
  openCard: (c) => set({ card: { ...c, key: crypto.randomUUID() }, toolbar: null }),
  updateCard: (patch) => set((s) => (s.card ? { card: { ...s.card, ...patch } } : {})),
  closeCard: () => set({ card: null }),

  panelOpen: false,
  panelPinned: false,
  panelConversationId: null,
  setPanel: (p) => set(p)
}))

/** 选区（Range）在视口中的位置 */
export function rangeRect(r: Range): Rect {
  const b = r.getBoundingClientRect()
  return { x: b.left, y: b.top, w: b.width, h: b.height }
}

export function elementRect(el: Element): Rect {
  const b = el.getBoundingClientRect()
  return { x: b.left, y: b.top, w: b.width, h: b.height }
}
