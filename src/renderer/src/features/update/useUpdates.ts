import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/utils'

export function useUpdates() {
  const queryClient = useQueryClient()
  useEffect(() => window.jiweiEvents.on('updates:changed', (state) => queryClient.setQueryData(['updates'], state)), [queryClient])
  return useQuery({ queryKey: ['updates'], queryFn: () => api.updates.status() })
}
