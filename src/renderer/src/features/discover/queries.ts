import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
export function useDiscoverEvents(): void {
  const qc = useQueryClient()
  useEffect(
    () =>
      window.jiweiEvents.on('discover:changed', () => {
        void qc.invalidateQueries({ queryKey: ['discover'] })
        void qc.invalidateQueries({ queryKey: ['inbox'] })
      }),
    [qc]
  )
}
