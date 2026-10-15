import { z } from 'zod'
export type Readiness =
  | { state: 'ready' }
  | { state: 'preparing'; reason: 'parsing' | 'indexing'; progress?: number }
  | { state: 'partial'; reason: 'scan-pending'; pending: number; total: number; action: 'recognize' | 'install-recognizer' | null }
  | {
      state: 'unreadable'
      reason: 'scan-pending' | 'unsupported' | 'needs-transcript' | 'empty' | 'failed'
      pending?: number
      total?: number
      action: 'recognize' | 'install-recognizer' | 'transcribe' | null
      note?: string
    }
export interface ReadinessItem {
  sourceId: string
  title: string
  readiness: Readiness
}
export function readinessMessage(r: Readiness): { key: string; values?: Record<string, string | number> } | null {
  if (r.state === 'ready') return null
  if (r.state === 'preparing')
    return r.reason === 'parsing' ? { key: 'readyParsing' } : { key: 'readyIndexing', values: { p: Math.floor((r.progress ?? 0) * 100) } }
  if (r.state === 'partial') return { key: 'readyScanPartial', values: { n: r.pending, total: r.total } }
  return {
    key: {
      'scan-pending': 'readyScanAll',
      unsupported: 'readyUnsupported',
      'needs-transcript': 'readyNeedsTranscript',
      empty: 'readyEmpty',
      failed: 'readyFailed'
    }[r.reason]
  }
}

export const ReadinessItemSchema = z.object({
  sourceId: z.string().min(1).max(64),
  title: z.string().max(500),
  readiness: z.discriminatedUnion('state', [
    z.object({ state: z.literal('ready') }),
    z.object({ state: z.literal('preparing'), reason: z.enum(['parsing', 'indexing']), progress: z.number().min(0).max(1).optional() }),
    z.object({
      state: z.literal('partial'),
      reason: z.literal('scan-pending'),
      pending: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      action: z.enum(['recognize', 'install-recognizer']).nullable()
    }),
    z.object({
      state: z.literal('unreadable'),
      reason: z.enum(['scan-pending', 'unsupported', 'needs-transcript', 'empty', 'failed']),
      pending: z.number().int().nonnegative().optional(),
      total: z.number().int().nonnegative().optional(),
      action: z.enum(['recognize', 'install-recognizer', 'transcribe']).nullable(),
      note: z.string().optional()
    })
  ])
})
