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

export const PhaseSave = z.object({
  id: z.string().min(1).optional(), goalId: z.string().min(1), title: z.string().trim().min(1).max(300),
  startAt: z.number().int(), endAt: z.number().int(), position: z.number().int().min(0).default(0),
  status: z.enum(['planned', 'active', 'done']).default('planned'), noteIds: z.array(z.string().min(1)).max(500).default([]), sourceIds: z.array(z.string().min(1)).max(500).default([])
}).refine((v) => v.endAt > v.startAt, 'Invalid phase dates')
export type GoalPhase = Omit<z.infer<typeof PhaseSave>, 'id'> & { id: string; progress: number }
export const MilestoneSave = z.object({ id: z.string().min(1).optional(), goalId: z.string().min(1), phaseId: z.string().nullable().default(null), title: z.string().trim().min(1).max(300), at: z.number().int(), doneAt: z.number().int().nullable().default(null) })
export type GoalMilestone = Omit<z.infer<typeof MilestoneSave>, 'id'> & { id: string }
export const IcsSave = z.object({ id: z.string().min(1).optional(), name: z.string().trim().min(1).max(200), url: z.string().min(1).max(4000), color: DirectionFields.color, enabled: z.boolean().default(true) })
export interface IcsFeed { id: string; name: string; url: string; color: string | null; enabled: boolean; lastFetchedAt: number | null; error: string | null; etag: string | null; lastModified: string | null }

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

export const ScheduleOptions = z.object({
  goalId: z.string().min(1), startAt: z.number().int(), targetAt: z.number().int(),
  weekdayMinutes: z.array(z.number().int().min(0).max(1440)).length(7),
  avoidExternal: z.boolean().default(true), preference: z.enum(['morning', 'afternoon', 'evening']).default('evening'),
  sessionMinutes: z.number().int().min(30).max(120).default(60)
}).refine((v) => v.targetAt >= v.startAt && v.targetAt - v.startAt < 366 * 86400000, 'Plan range must be within one year')
export type ScheduleInput = z.input<typeof ScheduleOptions>
export const ScheduleDraft = z.object({
  phases: z.array(z.object({ title: z.string().min(1).max(200), start: z.string().max(10), end: z.string().max(10), objective: z.string().max(500) })).min(1).max(12),
  milestones: z.array(z.object({ title: z.string().min(1).max(200), date: z.string().max(10) })).max(30),
  sessions: z.array(z.object({ date: z.string().max(10), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), minutes: z.number().int().min(30).max(120), title: z.string().min(1).max(200), phase: z.number().int().min(0).max(11) })).max(500),
  tradeoffs: z.string().max(2000)
})
export type ScheduleModel = z.infer<typeof ScheduleDraft>
export interface ValidSchedule {
  phases: { title: string; objective: string; startAt: number; endAt: number }[]
  milestones: { title: string; at: number }[]
  sessions: { title: string; startAt: number; endAt: number; phase: number }[]
  unplacedMinutes: number
  tradeoffs: string
}
export interface SchedulePreview extends ValidSchedule {
  id: string; options: z.infer<typeof ScheduleOptions>; expiresAt: number; cost: number; estimatedCost: number | null
}
export interface PlanLag { goalId: string; title: string; missed: number; milestones: number }
