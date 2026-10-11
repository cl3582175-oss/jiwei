import { sync, type VEvent } from 'node-ical'
import { addDays } from '@shared/plan'

export interface IcsOccurrence {
  uid: string
  title: string
  startAt: number
  endAt: number
  allDay: boolean
  note: string | null
}
const MAX_OCCURRENCES = 10000
const text = (v: unknown): string => (typeof v === 'string' ? v : v && typeof v === 'object' && 'val' in v ? String(v.val) : '')

/** 全天日期是浮动日期，不能先转换为 UTC 再当成本地时刻。 */
function localDate(d: Date, tz?: string): number {
  const parts = new Intl.DateTimeFormat('en', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d)
  const n = (type: string): number => Number(parts.find((p) => p.type === type)!.value)
  return new Date(n('year'), n('month') - 1, n('day')).getTime()
}

export function expandICS(body: string, range: { startAt: number; endAt: number }): IcsOccurrence[] {
  if (body.length > 2 * 1024 * 1024 || !body.includes('BEGIN:VCALENDAR') || !body.includes('END:VCALENDAR'))
    throw new Error('Invalid calendar')
  const parsed = sync.parseICS(body),
    result = new Map<string, IcsOccurrence>()
  for (const component of Object.values(parsed)) {
    if (component.type !== 'VEVENT' || component.status === 'CANCELLED') continue
    const event = component
    if (!event.uid || !(event.start instanceof Date) || !Number.isFinite(event.start.getTime())) throw new Error('Invalid calendar event')
    const allDay = event.datetype === 'date'
    const base = allDay ? localDate(event.start, event.start.tz) : event.start.getTime()
    const baseEnd =
      event.end instanceof Date
        ? allDay
          ? localDate(event.end, event.end.tz)
          : event.end.getTime()
        : allDay
          ? addDays(base, 1)
          : base + 60000
    const duration = Math.max(allDay ? 86400000 : 60000, baseEnd - base)
    // 秒级、分钟级无限规则会造成资源耗尽；报错并保留上次成功快照，不静默截掉事件。
    if (event.rrule && event.rrule.options.freq > 4) throw new Error('Calendar recurrence is too frequent')
    const dates = event.rrule
      ? event.rrule.between(
          new Date(range.startAt - duration - 86400000),
          new Date(range.endAt + 86400000),
          true,
          (_, i) => i < MAX_OCCURRENCES + 1
        )
      : [event.start]
    if (dates.length > MAX_OCCURRENCES) throw new Error('Calendar has too many events')
    for (const d of dates) {
      const key = d.toISOString().slice(0, 10)
      const override = event.recurrences?.[key]
      const excluded = event.exdate as Record<string, Date> | undefined
      if (excluded?.[key] && !override) continue
      if (override?.status === 'CANCELLED') continue
      const e: VEvent = override ?? event
      const at = override?.start ?? d
      const startAt = allDay ? localDate(at, event.start.tz) : at.getTime()
      const endAt = override?.end
        ? allDay
          ? localDate(override.end, override.end.tz)
          : override.end.getTime()
        : allDay
          ? addDays(startAt, Math.max(1, Math.round(duration / 86400000)))
          : startAt + duration
      if (startAt >= range.endAt || endAt <= range.startAt) continue
      const row = {
        uid: event.uid,
        title: text(e.summary).slice(0, 300) || '—',
        startAt,
        endAt: Math.max(startAt + 60000, endAt),
        allDay,
        note: text(e.description).slice(0, 4000) || null
      }
      result.set(`${event.uid}:${startAt}`, row)
      if (result.size > MAX_OCCURRENCES) throw new Error('Calendar has too many events')
    }
  }
  return [...result.values()].sort((a, b) => a.startAt - b.startAt)
}
