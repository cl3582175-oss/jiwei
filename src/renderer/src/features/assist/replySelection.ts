import { createContext, useEffect, type RefObject } from 'react'
import type { Anchor } from '@shared/context'
import { useAssist, rangeRect } from './store'

/** The existing reply selection boundary follows a reply surface without widening its permissions. */
export const ReplySelectionContext = createContext<{
  messageId?: string
  conversationId: string
  streaming: boolean
  restricted: boolean
} | null>(null)

export function quotedMessage(text: string, quote: string | null | undefined): string {
  return quote
    ? `${quote
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n\n${text}`
    : text
}
export function replyCandidate(start: HTMLElement | null, end: HTMLElement | null, selected: string, prefix: string, suffix: string) {
  const text = selected.trim()
  if (!start || start !== end || !text || !start.dataset.replyId || !start.dataset.conversationId || start.dataset.streaming === 'true')
    return null
  const anchor: Anchor = {
    kind: 'text',
    parentType: 'message',
    parentId: start.dataset.replyId,
    ownerId: start.dataset.conversationId,
    quote: text.slice(0, 8000),
    prefix: prefix.slice(-120),
    suffix: suffix.slice(0, 120)
  }
  return { anchor, text, restricted: Array.from(text).length > 2000 || start.dataset.replyRestricted === 'true' }
}
const elementOf = (node: Node): HTMLElement | null => (node.nodeType === 1 ? (node as HTMLElement) : node.parentElement)
export function useReplySelection(rootRef: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    const root = rootRef.current
    if (!root || !enabled) return
    let composing = false
    const startComposition = () => {
      composing = true
    }
    const endComposition = () => {
      composing = false
    }
    const select = (event: MouseEvent | KeyboardEvent) => {
      if (composing || (event instanceof KeyboardEvent && !event.shiftKey && event.key !== 'Shift')) return
      if ((event.target as HTMLElement)?.closest?.('a,button,input,textarea,[contenteditable=true]')) return
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        useAssist.getState().showToolbar(null)
        return
      }
      const range = selection.getRangeAt(0)
      const start = elementOf(range.startContainer)?.closest<HTMLElement>('[data-reply-id]') ?? null
      const end = elementOf(range.endContainer)?.closest<HTMLElement>('[data-reply-id]') ?? null
      if (!start || !root.contains(start) || start !== end) {
        useAssist.getState().showToolbar(null)
        return
      }
      const before = range.cloneRange(),
        after = range.cloneRange()
      before.selectNodeContents(start)
      before.setEnd(range.startContainer, range.startOffset)
      after.selectNodeContents(start)
      after.setStart(range.endContainer, range.endOffset)
      const candidate = replyCandidate(start, end, selection.toString(), before.toString(), after.toString())
      useAssist.getState().showToolbar(candidate ? { ...candidate, rect: rangeRect(range) } : null)
    }
    root.addEventListener('mouseup', select)
    root.addEventListener('keyup', select)
    root.addEventListener('compositionstart', startComposition)
    root.addEventListener('compositionend', endComposition)
    return () => {
      root.removeEventListener('mouseup', select)
      root.removeEventListener('keyup', select)
      root.removeEventListener('compositionstart', startComposition)
      root.removeEventListener('compositionend', endComposition)
    }
  }, [rootRef, enabled])
}
