import type { Trigger } from '@shared/tasks'

const matches = (t: Extract<Trigger, { type: 'schedule' }>, day: number): boolean =>
  t.every === 'day' || (t.every === 'weekday' ? day >= 1 && day <= 5 : !!t.days?.includes(day))
const timeOn = (t: Extract<Trigger, { type: 'schedule' }>, d: Date): number => {
  const [h, m] = t.time.split(':').map(Number)
  const at = new Date(d)
  at.setHours(h, m, 0, 0)
  return at.getTime()
}
export function nextTriggerAt(trigger: Trigger, after = Date.now()): number | null {
  if (trigger.type === 'interval') return after + trigger.minutes * 60000
  if (trigger.type !== 'schedule') return null
  const d = new Date(after)
  for (let i = 0; i < 8; i++) {
    if (matches(trigger, d.getDay())) {
      const at = timeOn(trigger, d)
      if (at > after) return at
    }
    d.setDate(d.getDate() + 1)
  }
  return null
}
export function previousScheduleAt(t: Trigger, now = Date.now()): number | null {
  if (t.type !== 'schedule') return null
  const d = new Date(now)
  for (let i = 0; i < 8; i++) {
    if (matches(t, d.getDay())) {
      const at = timeOn(t, d)
      if (at <= now) return at
    }
    d.setDate(d.getDate() - 1)
  }
  return null
}
export function catchUpAt(t: Trigger, lastRun: number | null, now = Date.now()): number | null {
  const at = previousScheduleAt(t, now)
  return at !== null && now - at <= 86400000 && (lastRun === null || lastRun < at) ? at : null
}
/** 轮询会跨过事件开始的毫秒；判断到期时刻穿过检查窗口，而不是要求时钟相等。 */
export function calendarTriggerDue(startAt: number, minutesBefore: number, after: number, now: number): boolean {
  const due = startAt - minutesBefore * 60000
  return due > after && due <= now
}
