import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Readiness } from '@shared/readiness'
import { api } from '@/lib/utils'

export function useReadinessMany(ids: string[], conversationId: string | null = null) {
  const selected = [...new Set(ids)].sort()
  return useQuery({
    queryKey: ['source-readiness', conversationId, selected],
    enabled: !!selected.length,
    queryFn: async () => {
      const groups = Array.from({ length: Math.ceil(selected.length / 500) }, (_, i) => selected.slice(i * 500, (i + 1) * 500))
      return Object.assign({}, ...(await Promise.all(groups.map((ids) => api.sources.readiness(ids, conversationId))))) as Record<
        string,
        Readiness
      >
    }
  })
}
/** 在应用根部订阅一次；批次索引/作业通知合并刷新，卡片不会逐个发IPC。 */
export function useReadinessEvents(): void {
  const qc = useQueryClient()
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const changed = () => {
      if (timer === null)
        timer = setTimeout(() => {
          timer = null
          void qc.invalidateQueries({ queryKey: ['source-readiness'] })
          void qc.invalidateQueries({ queryKey: ['source-upgrade'] })
        }, 100)
    }
    const events = [
      'sources:changed',
      'segments:changed',
      'jobs:changed',
      'recognition:source',
      'recognition:status',
      'embedding:status',
      'settings:changed',
      'attachments:changed'
    ] as const
    const offs = events.map((event) => window.jiweiEvents.on(event, changed))
    return () => {
      offs.forEach((off) => off())
      if (timer !== null) clearTimeout(timer)
    }
  }, [qc])
}
