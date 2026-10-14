import { createContext, createElement, useContext, useMemo, useState, type ReactNode } from 'react'
import type { ChatMessage } from '@shared/types'
import type { UiSettings } from '@shared/ui/settings'
import { UI_DEFAULTS } from '@shared/ui/settings'
import { useSettings } from '@/lib/queries'

export type UiState = Record<string, unknown>
export interface UiContext {
  messageId: string
  conversationId: string
  isLatest: boolean
  streaming: boolean
  stopped: boolean
  compact: boolean
  context: 'chat' | 'note'
  settings: UiSettings
  message?: ChatMessage
  fenceIndex(meta?: string): number
  states: Record<string, UiState>
  setState(key: string, patch: UiState): void
}
export const UiMessageContext = createContext<UiContext | null>(null)
export function useUiContext(): UiContext {
  const ctx = useContext(UiMessageContext)
  if (!ctx) throw new Error('Missing UI message context')
  return ctx
}
export function UiMessageProvider({
  message,
  isLatest,
  compact,
  children
}: {
  message: ChatMessage
  isLatest: boolean
  compact: boolean
  children: ReactNode
}) {
  const { data: settings } = useSettings()
  const [states, setStates] = useState<Record<string, UiState>>({})
  const value = useMemo<UiContext>(
    () => ({
      messageId: message.id,
      conversationId: message.conversationId,
      isLatest,
      streaming: message.status === 'streaming',
      stopped: message.status === 'stopped',
      compact,
      context: 'chat',
      message,
      settings: settings?.ai.ui ?? UI_DEFAULTS,
      states,
      fenceIndex: (meta) => Number(/jiwei-index=(\d+)/.exec(meta ?? '')?.[1] ?? 0),
      setState: (key, patch) => setStates((old) => ({ ...old, [key]: { ...old[key], ...patch } }))
    }),
    [message, isLatest, compact, settings, states]
  )
  return createElement(UiMessageContext.Provider, { value }, children)
}
