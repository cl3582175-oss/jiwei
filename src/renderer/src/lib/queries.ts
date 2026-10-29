import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { CategoryKind, NoteQuery, Settings, SourceQuery } from '@shared/types'
import { api } from './utils'
import { createSettingsUpdates, type SettingsUpdate } from './settingsUpdates'

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

const settingsCoordinators = new WeakMap<QueryClient, ReturnType<typeof createSettingsUpdates>>()

function settingsCoordinator(qc: QueryClient) {
  let coordinator = settingsCoordinators.get(qc)
  if (!coordinator) {
    coordinator = createSettingsUpdates({
      initial: qc.getQueryData<Settings>(keys.settings),
      read: () => api.settings.get(),
      write: (patch) => api.settings.set(patch),
      publish: (settings) => {
        qc.setQueryData(keys.settings, settings)
      }
    })
    settingsCoordinators.set(qc, coordinator)
  }
  return coordinator
}

export const refreshSettings = (qc: QueryClient): Promise<Settings> => settingsCoordinator(qc).refresh()
export const updateSettings = (qc: QueryClient, patch: SettingsUpdate): Promise<Settings> => settingsCoordinator(qc).update(patch)
export const flushSettings = (qc: QueryClient): Promise<void> => settingsCoordinator(qc).flush()
export const settingsDirty = (qc: QueryClient): boolean => settingsCoordinator(qc).dirty

export function useSettings() {
  const qc = useQueryClient()
  const coordinator = settingsCoordinator(qc)
  return useQuery({
    queryKey: keys.settings,
    queryFn: () => coordinator.refresh(),
    staleTime: Infinity,
    // A refetch finishing after publish() must retain the current pending view.
    structuralSharing: (_previous, incoming) => coordinator.snapshot ?? incoming
  })
}

export function useUpdateSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: SettingsUpdate) => updateSettings(qc, patch)
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

export function useChatProjects() {
  const qc = useQueryClient()
  useEffect(
    () =>
      window.jiweiEvents.on('chatProjects:changed', () => {
        void qc.invalidateQueries({ queryKey: ['chatProjects'] })
        void qc.invalidateQueries({ queryKey: ['projectConversations'] })
        void qc.invalidateQueries({ queryKey: ['conversations'] })
        void qc.invalidateQueries({ queryKey: ['memories'] })
      }),
    [qc]
  )
  // 项目记忆条数随记忆变化（「关于我」只列出有记忆的项目）
  useEffect(() => window.jiweiEvents.on('memory:changed', () => void qc.invalidateQueries({ queryKey: ['chatProjects'] })), [qc])
  return useQuery({ queryKey: ['chatProjects'], queryFn: () => api.chatProjects.list() })
}

export function useProjectConversations(id: string) {
  const qc = useQueryClient()
  useEffect(
    () =>
      window.jiweiEvents.on('chat:done', () => {
        void qc.invalidateQueries({ queryKey: ['projectConversations', id] })
      }),
    [qc, id]
  )
  return useQuery({ queryKey: ['projectConversations', id], queryFn: () => api.chatProjects.conversations(id) })
}

/** Project source processing has no persistent polling once it reaches a terminal state. */
export function useProjectSources(id: string) {
  const qc = useQueryClient()
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const changed = (): void => {
      if (timer) return
      timer = setTimeout(() => {
        timer = undefined
        void qc.invalidateQueries({ queryKey: ['projectSources', id] })
      }, 100)
    }
    const offs = (
      [
        'chatProjects:changed',
        'sources:changed',
        'notes:changed',
        'segments:changed',
        'attachments:changed',
        'jobs:changed',
        'recognition:source',
        'recognition:status',
        'settings:changed',
        'providers:changed',
        'embedding:status'
      ] as const
    ).map((event) => window.jiweiEvents.on(event, changed))
    return () => {
      offs.forEach((off) => off())
      clearTimeout(timer)
    }
  }, [qc, id])
  return useQuery({
    queryKey: ['projectSources', id],
    queryFn: () => api.chatProjects.sources(id),
    refetchInterval: (query) =>
      query.state.data?.some(
        (item) => item.readiness?.state === 'preparing' || (item.readiness && 'recognizing' in item.readiness && item.readiness.recognizing)
      )
        ? 1000
        : false
  })
}

export function useMemories(projectId?: string) {
  return useQuery({
    queryKey: projectId ? ['memories', 'project', projectId] : ['memories'],
    queryFn: () => api.memory.list(projectId ? { projectId } : {})
  })
}

export function useUserProfile() {
  return useQuery({ queryKey: ['userProfile'], queryFn: () => api.memory.profile() })
}

export function useSkills() {
  return useQuery({ queryKey: ['skills'], queryFn: () => api.skills.list() })
}
