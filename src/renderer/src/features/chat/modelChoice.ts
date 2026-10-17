import { create } from 'zustand'
import { useQuery } from '@tanstack/react-query'
import type { Effort } from '@shared/ai'
import { useProviders, useSettings } from '@/lib/queries'
import { api } from '@/lib/utils'
import type { ModelChoice } from '../ai/ModelPicker'

interface Selection {
  choice: ModelChoice
  effort: Effort
}

const useSelections = create<{
  values: Record<string, Selection>
  save: (key: string, value: Selection) => void
  adopt: (draft: string, conversation: string, value: Selection) => void
}>((set) => ({
  values: {},
  save: (key, value) => set((s) => ({ values: { ...s.values, [key]: value } })),
  adopt: (draft, conversation, value) =>
    set((s) => {
      const values = { ...s.values, [conversation]: value }
      // A slow send must not discard a newer unsent choice in the draft.
      if (values[draft] === value) delete values[draft]
      return { values }
    })
}))

/** Project home and the conversation share a selection, including across page unmounts. */
export function useChatModelChoice(conversationId: string | null, projectId: string | null) {
  const { data: settings } = useSettings()
  const { data: providers = [], isPending: loadingProviders } = useProviders()
  const key = conversationId ? `conversation:${conversationId}` : `draft:${projectId ?? 'ordinary'}`
  const saved = useSelections((s) => s.values[key])
  const { data: messages } = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () => api.chat.messages(conversationId!),
    enabled: !!conversationId
  })
  const last = messages
    ?.slice()
    .reverse()
    .find((m) => m.role === 'assistant' && providers.some((p) => p.enabled && p.id === m.providerId && p.models.includes(m.model ?? '')))
  const ready = !!settings && !loadingProviders && (!conversationId || !!saved || messages !== undefined)
  const selection: Selection = saved ?? {
    choice: ready ? (last ? { providerId: last.providerId, model: last.model } : settings!.ai.chat) : { providerId: null, model: null },
    effort: last?.effort ?? settings?.ai.effort ?? 'high'
  }
  const setChoice = (choice: ModelChoice): void => useSelections.getState().save(key, { ...selection, choice })
  const setEffort = (effort: Effort): void => useSelections.getState().save(key, { ...selection, effort })
  const rememberConversation = (id: string): void => {
    if (!conversationId) useSelections.getState().adopt(key, `conversation:${id}`, selection)
  }
  const provider = providers.find((p) => p.id === selection.choice.providerId) ?? null
  return { ...selection, setChoice, setEffort, provider, rememberConversation }
}
