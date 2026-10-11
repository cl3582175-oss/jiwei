import { describe, expect, it } from 'vitest'
import { validateSchedule, replaceableEvent, effectiveStudyMs } from '../../services/plan/validate'
import { dayStart, addDays, localDay } from '@shared/plan'

const start = dayStart(new Date(2026, 9, 12)),
  end = addDays(start, 4) - 1
const options = {
  goalId: 'g',
  startAt: start,
  targetAt: end,
  weekdayMinutes: [120, 120, 120, 120, 120, 120, 120],
  avoidExternal: true,
  preference: 'morning' as const,
  sessionMinutes: 60
}
const draft = {
  phases: [{ title: '基础', start: localDay(start), end: localDay(end), objective: '掌握基础' }],
  milestones: [],
  sessions: [{ date: localDay(start), time: '10:00', minutes: 60, title: '基础练习', phase: 0 }],
  tradeoffs: '优先基础'
}
describe('排期的主进程约束', () => {
  it('将忙碌时间冲突顺延，扣除复习负荷及已保留的学习投入', () => {
    const r = validateSchedule(
      draft,
      options,
      {
        busy: [{ startAt: start + 10 * 3600000, endAt: start + 11 * 3600000 }],
        review: [{ date: localDay(start), due: 20, new: 0 }],
        committed: {}
      },
      start
    )
    expect(r.sessions[0].startAt).toBe(start + 11 * 3600000)
    const capped = validateSchedule(
      { ...draft, sessions: [...draft.sessions, ...draft.sessions] },
      options,
      { busy: [], review: [], committed: { [localDay(start)]: 90 } },
      start
    )
    expect(capped.sessions).toHaveLength(0)
    expect(capped.unplacedMinutes).toBe(120)
  })
  it('不排截止后、已过期或阶段范围外时段，并将阶段首尾衔接', () => {
    const r = validateSchedule(
      {
        ...draft,
        phases: [...draft.phases, { ...draft.phases[0], title: '进阶', end: localDay(end) }],
        sessions: [{ ...draft.sessions[0], date: localDay(addDays(start, 6)) }]
      },
      options,
      { busy: [], review: [], committed: {} },
      start
    )
    expect(r.sessions).toHaveLength(0)
    expect(r.phases[1].startAt).toBe(r.phases[0].endAt)
    expect(r.phases.at(-1)?.endAt).toBe(addDays(dayStart(end), 1))
  })
  it('再排期只替换未开始且未完成的 AI 时段', () => {
    const e = { origin: 'ai', startAt: start + 3600000, status: 'planned' }
    expect(replaceableEvent(e, start)).toBe(true)
    expect(replaceableEvent({ ...e, origin: 'user' }, start)).toBe(false)
    expect(replaceableEvent({ ...e, status: 'done' }, start)).toBe(false)
    expect(replaceableEvent({ ...e, startAt: start - 1 }, start)).toBe(false)
  })
  it('学习活动只取时段内的交集，重叠记录不重复计时', () => {
    expect(
      effectiveStudyMs(
        [
          { at: 100, durationMs: 80 },
          { at: 120, durationMs: 80 },
          { at: 1000, durationMs: 20 }
        ],
        50,
        110
      )
    ).toBe(60)
  })
})
