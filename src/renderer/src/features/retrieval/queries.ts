import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/utils'

export const retrievalKeys = {
  all: ['retrieval'] as const,
  status: ['retrieval', 'status'] as const
}

export function useRetrievalStatus() {
  const qc = useQueryClient()
  // 状态含今日次数；新挂载的设置页不能沿用搜索前的短期缓存。
  const query = useQuery({ queryKey: retrievalKeys.status, queryFn: () => api.retrieval.status(), staleTime: 0 })
  useEffect(() => window.jiweiEvents.on('retrieval:changed', () => void qc.invalidateQueries({ queryKey: retrievalKeys.status })), [qc])
  useEffect(() => {
    const pauses = query.data?.backends.map((backend) => backend.pausedUntil).filter((until): until is number => until !== null) ?? []
    if (!pauses.length) return
    const next = Math.min(...pauses)
    // 熔断到期不会有新的后端请求触发事件；一次定时重取，避免按钮长期停留在暂停状态。
    const timer = window.setTimeout(
      () => void qc.invalidateQueries({ queryKey: retrievalKeys.status }),
      Math.max(0, Math.min(next - Date.now() + 1, 2_147_483_647))
    )
    return () => window.clearTimeout(timer)
  }, [qc, query.data])
  return query
}
