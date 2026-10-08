import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { CategoryKind, NoteQuery, Settings, SourceQuery } from '@shared/types'
import { api } from './utils'

export const keys = {
  settings: ['settings'] as const,
  appInfo: ['appInfo'] as const,
  categories: (kind: CategoryKind) => ['categories', kind] as const,
  notes: (q?: NoteQuery) => (q ? (['notes', q] as const) : (['notes'] as const)),
  note: (id: string) => ['note', id] as const,
  sources: (q?: SourceQuery) => (q ? (['sources', q] as const) : (['sources'] as const)),
  trash: ['trash'] as const,
  heatmap: ['heatmap'] as const,
  tags: ['tags'] as const
}

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: () => api.settings.get(), staleTime: Infinity })
}

export function useUpdateSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<Settings>) => api.settings.set(patch),
    onMutate: (patch) => {
      const prev = qc.getQueryData<Settings>(keys.settings)
      if (prev) qc.setQueryData(keys.settings, { ...prev, ...patch })
    },
    onSuccess: (s) => qc.setQueryData(keys.settings, s)
  })
}

export function useAppInfo() {
  return useQuery({ queryKey: keys.appInfo, queryFn: () => api.app.info(), staleTime: Infinity })
}

export function useCategories(kind: CategoryKind) {
  return useQuery({ queryKey: keys.categories(kind), queryFn: () => api.categories.list(kind) })
}

export function useNotes(q: NoteQuery) {
  return useQuery({ queryKey: keys.notes(q), queryFn: () => api.notes.list(q), placeholderData: (p) => p })
}

export function useNote(id: string | null) {
  return useQuery({
    queryKey: keys.note(id ?? ''),
    queryFn: () => api.notes.get(id!),
    enabled: !!id
  })
}

export function useSources(q: SourceQuery) {
  return useQuery({ queryKey: keys.sources(q), queryFn: () => api.sources.list(q), placeholderData: (p) => p })
}

export function useTrash() {
  return useQuery({ queryKey: keys.trash, queryFn: () => api.trash.list() })
}

export function useTags() {
  return useQuery({ queryKey: keys.tags, queryFn: () => api.tags.list() })
}

export function useProviders() {
  return useQuery({ queryKey: ['providers'], queryFn: () => api.providers.list() })
}

export function useConversations() {
  return useQuery({ queryKey: ['conversations'], queryFn: () => api.chat.conversations() })
}

/** 向量模型与索引状态：订阅主进程推送 */
export function useEmbeddingStatus() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['embedding'], queryFn: () => api.embedding.status() })
  useEffect(() => window.jiweiEvents.on('embedding:status', (s) => qc.setQueryData(['embedding'], s)), [qc])
  return q
}

export function useHeatmap(days: number) {
  return useQuery({ queryKey: [...keys.heatmap, days], queryFn: () => api.stats.heatmap(days) })
}

/** 数据变更后刷新相关列表 */
export function invalidate(
  qc: QueryClient,
  ...groups: ('notes' | 'note' | 'sources' | 'trash' | 'categories' | 'heatmap' | 'tags' | 'blocks')[]
): void {
  for (const g of groups) void qc.invalidateQueries({ queryKey: [g] })
}
