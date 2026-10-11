import { z } from 'zod'

export const DirectionFields = {
  kind: z.enum(['exam', 'skill', 'project', 'interest']).optional(),
  startAt: z.number().int().nullable().optional(),
  weeklyMinutes: z.number().int().min(0).max(10080).nullable().optional(),
  weekdayMinutes: z.array(z.number().int().min(0).max(1440)).length(7).nullable().optional(),
  color: z.enum(['bamboo', 'sky', 'lotus', 'apricot', 'sakura', 'gosling', 'moon']).nullable().optional()
}
export const EventRange = z
  .object({ startAt: z.number().int(), endAt: z.number().int() })
  .refine((v) => v.endAt > v.startAt, 'Invalid range')
export const EventSave = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().trim().min(1).max(300),
    kind: z.enum(['study', 'exam', 'deadline', 'event']),
    startAt: z.number().int(),
    endAt: z.number().int(),
    allDay: z.boolean().default(false),
    goalId: z.string().min(1).nullable().optional(),
    phaseId: z.string().min(1).nullable().optional(),
    status: z.enum(['planned', 'done', 'skipped']).optional(),
    note: z.string().max(4000).nullable().optional()
  })
  .refine((v) => v.endAt > v.startAt && v.endAt - v.startAt <= 366 * 86400000, 'Invalid event duration')
export type EventInput = z.input<typeof EventSave>
export type PlanEvent = Omit<z.infer<typeof EventSave>, 'id' | 'goalId' | 'phaseId' | 'status' | 'note'> & {
  id: string
  goalId: string | null
  phaseId: string | null
  status: 'planned' | 'done' | 'skipped'
  note: string | null
  origin: 'user' | 'ai' | 'ics'
  feedId: string | null
  uid: string | null
  readonly?: boolean
  link?: { type: 'goal' | 'action'; id: string }
  color?: string | null
}
export interface ReviewForecast {
  date: string
  due: number
  new: number
}

export function localDay(t: number | Date = Date.now()): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export function dayStart(t: number | Date = Date.now()): number {
  return new Date(t).setHours(0, 0, 0, 0)
}
export function addDays(t: number, days: number): number {
  const d = new Date(t)
  d.setDate(d.getDate() + days)
  return d.getTime()
}
