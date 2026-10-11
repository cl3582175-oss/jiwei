import { addDays, dayStart, localDay, type ReviewForecast, type ScheduleModel, type ValidSchedule, ScheduleOptions } from '@shared/plan'
import type { z } from 'zod'

export function replaceableEvent(e: { origin: string; status: string; startAt: number }, now: number): boolean {
  return e.origin === 'ai' && e.status === 'planned' && e.startAt > now
}
export interface ScheduleConstraints {
  busy: { startAt: number; endAt: number }[]
  review: ReviewForecast[]
  committed: Record<string, number>
}
const dateAt = (s: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN
  const t = new Date(`${s}T00:00:00`).getTime()
  return Number.isFinite(t) && localDay(t) === s ? t : NaN
}

/** 不接受模型决定权限或时间容量；这里是预览和确认共用的纯约束层。 */
export function validateSchedule(
  draft: ScheduleModel,
  options: z.infer<typeof ScheduleOptions>,
  c: ScheduleConstraints,
  now = Date.now()
): ValidSchedule {
  const first = Math.max(dayStart(options.startAt), dayStart(now)),
    last = addDays(dayStart(options.targetAt), 1)
  const days = Math.round((last - first) / 86400000)
  if (days < 1) throw new Error('The direction has already ended')
  const phases: ValidSchedule['phases'] = [],
    count = Math.min(draft.phases.length, days)
  let cursor = first
  for (let i = 0; i < count; i++) {
    const p = draft.phases[i],
      proposed = addDays(dateAt(p.end), 1)
    const end =
      i === count - 1
        ? last
        : Math.min(
            addDays(last, -(count - i - 1)),
            Math.max(addDays(cursor, 1), Number.isFinite(proposed) ? proposed : addDays(cursor, Math.max(1, Math.floor(days / count))))
          )
    phases.push({ title: p.title, objective: p.objective, startAt: cursor, endAt: end })
    cursor = end
  }
  const sessions: ValidSchedule['sessions'] = [],
    busy = [...c.busy],
    used = { ...c.committed }
  let unplacedMinutes = 0
  const [from, until] = { morning: [6, 12], afternoon: [12, 18], evening: [18, 24] }[options.preference]
  for (const s of [...draft.sessions].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))) {
    const day = dateAt(s.date),
      minutes = Math.min(s.minutes, options.sessionMinutes)
    const load = c.review.find((r) => r.date === s.date),
      available = options.weekdayMinutes[new Date(day).getDay()] - ((load?.due ?? 0) + (load?.new ?? 0)) * 0.5 - (used[s.date] ?? 0)
    if (!Number.isFinite(day) || day < first || day >= last || available < minutes || s.phase >= phases.length) {
      unplacedMinutes += s.minutes
      continue
    }
    const phase = phases.findIndex((p) => day >= p.startAt && day < p.endAt)
    const [h, m] = s.time.split(':').map(Number),
      start = new Date(day),
      stop = new Date(day)
    start.setHours(h, m)
    stop.setHours(until, 0)
    const earliest = new Date(day)
    earliest.setHours(from, 0)
    let at = Math.max(start.getTime(), earliest.getTime(), now)
    at = Math.ceil(at / (15 * 60000)) * 15 * 60000
    const duration = minutes * 60000
    for (;;) {
      const conflict = busy.find((b) => at < b.endAt && at + duration > b.startAt)
      if (!conflict) break
      at = Math.ceil(conflict.endAt / (15 * 60000)) * 15 * 60000
    }
    if (at + duration > stop.getTime() || at + duration > options.targetAt || phase < 0) {
      unplacedMinutes += s.minutes
      continue
    }
    const event = { title: s.title, startAt: at, endAt: at + duration, phase }
    sessions.push(event)
    busy.push(event)
    used[s.date] = (used[s.date] ?? 0) + minutes
    unplacedMinutes += s.minutes - minutes
  }
  const milestones = draft.milestones
    .map((m) => ({ title: m.title, at: dateAt(m.date) }))
    .filter((m) => Number.isFinite(m.at) && m.at >= first && m.at < last && m.at <= options.targetAt)
  return { phases, milestones, sessions, unplacedMinutes, tradeoffs: draft.tradeoffs }
}

/** 活动 at 是上报的结束时间；合并交集，避免多窗口上报把同一分钟算两次。 */
export function effectiveStudyMs(rows: { at: number; durationMs: number }[], start: number, end: number): number {
  const spans = rows
    .map((r) => [Math.max(start, r.at - r.durationMs), Math.min(end, r.at)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0])
  let total = 0,
    right = start
  for (const [a, b] of spans) {
    total += Math.max(0, b - Math.max(a, right))
    right = Math.max(right, b)
  }
  return total
}
