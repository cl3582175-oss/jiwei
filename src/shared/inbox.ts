import { z } from 'zod'
import { isDeepSeekPeak } from './ai'

export const InboxSuggestionSchema = z.object({
  type: z.enum(['textbook_page', 'board', 'handwritten_note', 'wrong_question', 'article', 'idea', 'todo', 'other']),
  action: z.enum(['append_note', 'new_note', 'save_source', 'action_item', 'keep']),
  noteId: z.string().max(64).optional(),
  newNoteTitle: z.string().max(200).optional(),
  rows: z
    .array(z.object({ cue: z.string().max(1000), body: z.string().max(12000) }))
    .min(1)
    .max(5)
    .optional(),
  actionTitle: z.string().max(300).optional(),
  dueAt: z.string().max(100).optional(),
  goalId: z.string().max(64).optional(),
  groupWith: z.array(z.string().max(64)).max(9).optional(),
  reason: z.string().max(1000)
})
export type InboxSuggestion = z.infer<typeof InboxSuggestionSchema>
export const InboxOriginSchema = z.object({
  recordingSourceId: z.uuid().optional(),
  app: z.string().max(200).optional(),
  windowTitle: z.string().max(500).optional(),
  url: z
    .url()
    .max(4096)
    .refine((v) => /^https?:\/\//i.test(v))
    .optional(),
  device: z.literal('phone').optional(),
  sessionId: z
    .string()
    .regex(/^[\w-]{1,64}$/)
    .optional()
})
export const InboxCreateSchema = z
  .object({
    kind: z.enum(['text', 'screenshot', 'photo', 'file', 'clip']),
    text: z.string().max(100000).default(''),
    assetId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    origin: InboxOriginSchema.default({})
  })
  .refine((v) => !!v.text.trim() || !!v.assetId, 'Content required')
export const InboxUpdateSchema = z.object({ text: z.string().max(100000).optional(), status: z.enum(['new', 'dismissed']).optional() })
export const InboxAcceptSchema = z.object({
  action: z.enum(['append_note', 'new_note', 'save_source', 'keep']),
  noteId: z.uuid().optional(),
  newNoteTitle: z.string().max(200).optional()
})
export type InboxCreate = z.infer<typeof InboxCreateSchema>
export type InboxOrigin = z.infer<typeof InboxOriginSchema>
export interface InboxDestination {
  noteId?: string
  proposalId?: string
  sourceIds?: string[]
  actionId?: string
  members: string[]
  blockIds?: string[]
}
export interface InboxItem {
  id: string
  kind: InboxCreate['kind']
  text: string
  assetId: string | null
  assetUrl: string | null
  assetMime: string | null
  recognized: string
  recognitionStatus: 'pending' | 'ready' | 'unavailable' | 'failed' | 'canceled' | 'none'
  origin: InboxOrigin
  status: 'new' | 'suggested' | 'filed' | 'dismissed'
  suggestion: InboxSuggestion | null
  filedTo: InboxDestination | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}
export const localDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export function relativeDueAt(value: string | undefined, capturedAt: number): string | undefined {
  if (!value) return undefined
  const d = new Date(capturedAt)
  const day = /^(today|今天|tomorrow|明天|后天)$/i.exec(value)
  const days = /^(?:in )?(\d{1,3})\s*(?:days?|天后)$/i.exec(value)
  if (day || days) {
    d.setDate(d.getDate() + (days ? Number(days[1]) : /tomorrow|明天/i.test(value) ? 1 : value === '后天' ? 2 : 0))
    return localDay(d)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const parsed = new Date(`${value}T12:00:00`)
  return Number.isFinite(parsed.getTime()) && localDay(parsed) === value ? value : undefined
}
export function normalizeSuggestion(
  input: InboxSuggestion,
  noteIds: string[],
  goalIds: string[],
  capturedAt: number,
  groupIds: string[] = []
): InboxSuggestion {
  const s = { ...input }
  if (s.action === 'append_note' && (!s.noteId || !noteIds.includes(s.noteId))) {
    s.action = 'new_note'
    delete s.noteId
  }
  if (s.goalId && !goalIds.includes(s.goalId)) delete s.goalId
  s.dueAt = relativeDueAt(s.dueAt, capturedAt)
  s.groupWith = s.groupWith?.filter((id) => groupIds.includes(id))
  return s
}
export function phoneGroups(items: { id: string; createdAt: number; origin: InboxOrigin }[]): string[][] {
  const groups: { ids: string[]; session?: string; at: number }[] = []
  for (const item of [...items].sort((a, b) => a.createdAt - b.createdAt)) {
    const session = item.origin.device === 'phone' ? item.origin.sessionId : undefined
    const group = session && groups.find((g) => g.session === session && g.ids.length < 10 && item.createdAt - g.at <= 5 * 60_000)
    if (group) {
      group.ids.push(item.id)
      group.at = item.createdAt
    } else groups.push({ ids: [item.id], session, at: item.createdAt })
  }
  return groups.map((g) => g.ids)
}
export function nextOffPeak(at: number): number {
  let next = at
  while (isDeepSeekPeak(next)) next = Math.floor(next / 3_600_000) * 3_600_000 + 3_600_000
  return next
}
export function scheduleDay(now: Date, time: string, last: string | null): string | null {
  const today = localDay(now)
  const [h, m] = time.split(':').map(Number)
  return (last && last >= today) || now.getHours() * 60 + now.getMinutes() < h * 60 + m ? null : today
}
