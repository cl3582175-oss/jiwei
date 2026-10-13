import { create } from 'zustand'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ADVISOR_CANCELED } from '@shared/advisor'
import { api } from '@/lib/utils'

interface Draft {
  question: string
  context: string
  showContext: boolean
  goalId: string
  frameworkId: string
}
export const useAdvisorState = create<{ draft: Draft; active: Record<string, number>; stopped: Record<string, number> }>(() => ({
  draft: { question: '', context: '', showContext: false, goalId: '', frameworkId: '' },
  active: {},
  stopped: {}
}))
export function setAdvisorDraft(patch: Partial<Draft>): void {
  useAdvisorState.setState((s) => ({ draft: { ...s.draft, ...patch } }))
}
let sequence = 0
export function useAdvisorGeneration(target: string) {
  const qc = useQueryClient()
  const active = useAdvisorState((s) => s.active[target])
  const stopped = useAdvisorState((s) => s.stopped[target])
  const { data: running = [] } = useQuery({ queryKey: ['advisor', 'running'], queryFn: () => api.advisor.running() })
  const run = async <T>(fn: () => Promise<T>, onDone?: (result: T) => void): Promise<void> => {
    if (useAdvisorState.getState().active[target] !== undefined) return
    const token = ++sequence
    useAdvisorState.setState((s) => ({ active: { ...s.active, [target]: token }, stopped: { ...s.stopped, [target]: 0 } }))
    try {
      const result = await fn()
      if (useAdvisorState.getState().active[target] === token) onDone?.(result)
    } catch (error) {
      if (useAdvisorState.getState().active[target] === token && !String(error).includes(ADVISOR_CANCELED))
        toast.error(String(error instanceof Error ? error.message : error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      useAdvisorState.setState((s) => {
        if (s.active[target] !== token) return s
        const next = { ...s.active }
        delete next[target]
        return { active: next }
      })
      void qc.invalidateQueries({ queryKey: ['advisor'] })
    }
  }
  const stop = async (): Promise<void> => {
    const stopToken = ++sequence
    useAdvisorState.setState((s) => {
      const next = { ...s.active }
      delete next[target]
      return { active: next, stopped: { ...s.stopped, [target]: stopToken } }
    })
    qc.setQueryData<string[]>(['advisor', 'running'], (list) => list?.filter((id) => id !== target) ?? [])
    try {
      await api.advisor.cancel(target)
    } catch (error) {
      toast.error(String(error))
    }
    void qc.invalidateQueries({ queryKey: ['advisor', 'running'] })
    setTimeout(() => {
      if (useAdvisorState.getState().stopped[target] === stopToken)
        useAdvisorState.setState((s) => ({ stopped: { ...s.stopped, [target]: 0 } }))
    }, 3000)
  }
  return { busy: active !== undefined || running.includes(target), stopped, run, stop }
}
