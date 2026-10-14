import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/utils'
import { toast } from 'sonner'
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
  setState(key: string, patch: UiState, immediate?: boolean): void
  flushState?(key?: string): Promise<void>
  snapshot?(key: string, text?: string): string | undefined
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
  const qc = useQueryClient()
  const queryKey = useMemo(() => ['ui-states', message.id], [message.id])
  const { data: saved } = useQuery({ queryKey, queryFn: () => api.ui.states(message.id), staleTime: Infinity })
  const [states, setStates] = useState<Record<string, UiState>>({})
  const snapshots = useRef<Record<string, string>>({})
  const current = useRef<Record<string, UiState>>({}),
    pending = useRef(new Set<string>()),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flushState = useCallback(
    async (key?: string) => {
      const keys = key ? (pending.current.has(key) ? [key] : []) : [...pending.current]
      for (const k of keys) {
        const state = current.current[k]
        await api.ui.saveState(message.id, k, state)
        if (current.current[k] === state) pending.current.delete(k)
      }
    },
    [message.id]
  )
  useEffect(() => {
    if (!saved) return
    const loaded = Object.fromEntries(
      Object.entries(saved).filter(
        (entry): entry is [string, UiState] => !!entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1])
      )
    )
    current.current = { ...loaded, ...current.current }
    setStates(current.current)
  }, [saved])
  useEffect(() => {
    const flush = (): void => {
      clearTimeout(timer.current)
      void flushState().catch(() => undefined)
    }
    const off = window.jiweiEvents.on('app:flush', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      off()
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [flushState])
  const setState = useCallback(
    (key: string, patch: UiState, immediate = false) => {
      current.current = { ...current.current, [key]: { ...current.current[key], ...patch } }
      pending.current.add(key)
      setStates(current.current)
      qc.setQueryData(queryKey, current.current)
      clearTimeout(timer.current)
      if (immediate) void flushState(key).catch((e) => toast.error(String(e)))
      else
        timer.current = setTimeout(() => {
          void flushState().catch((e) => toast.error(String(e)))
        }, 300)
    },
    [qc, queryKey, flushState]
  )
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
      setState,
      flushState,
      snapshot: (key, text) => {
        if (text !== undefined) snapshots.current[key] = text
        return snapshots.current[key]
      }
    }),
    [message, isLatest, compact, settings, states, setState, flushState]
  )
  return createElement(UiMessageContext.Provider, { value }, children)
}
