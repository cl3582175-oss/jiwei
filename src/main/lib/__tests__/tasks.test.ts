import { describe, expect, it } from 'vitest'
import { nextTriggerAt, previousScheduleAt, catchUpAt, calendarTriggerDue } from '../../services/tasks/triggers'
import { taskPermission } from '../../services/tasks/policy'

describe('任务本地时间调度与补跑', () => {
  it('每日与工作日跨天，以本地时分构造', () => {
    const at = new Date(2026, 9, 16, 9).getTime()
    expect(nextTriggerAt({ type: 'schedule', every: 'day', time: '08:00' }, at)).toBe(new Date(2026, 9, 17, 8).getTime())
    expect(nextTriggerAt({ type: 'schedule', every: 'weekday', time: '08:00' }, at)).toBe(new Date(2026, 9, 19, 8).getTime())
  })
  it('每周选定星期、间隔最少30分钟', () => {
    const at = new Date(2026, 9, 16, 9).getTime()
    expect(nextTriggerAt({ type: 'schedule', every: 'week', time: '09:00', days: [0] }, at)).toBe(new Date(2026, 9, 18, 9).getTime())
    expect(nextTriggerAt({ type: 'interval', minutes: 30 }, at)).toBe(at + 1800000)
  })
  it('错过多次只补最近一次，超过24小时不补', () => {
    const t = { type: 'schedule' as const, every: 'day' as const, time: '08:00' },
      now = new Date(2026, 9, 17, 9).getTime()
    const previous = previousScheduleAt(t, now)!
    expect(catchUpAt(t, now - 3 * 86400000, now)).toBe(previous)
    expect(catchUpAt(t, previous, now)).toBeNull()
    expect(catchUpAt({ type: 'schedule', every: 'week', time: '08:00', days: [4] }, 0, now)).toBeNull()
  })
  it('日历零分钟触发跨过开始时刻也运行，只接收检查窗口内的到期时刻', () => {
    const now = new Date(2026, 9, 11, 9, 0, 23).getTime()
    expect(calendarTriggerDue(now - 23000, 0, now - 60000, now)).toBe(true)
    expect(calendarTriggerDue(now + 30 * 60000 - 23000, 30, now - 60000, now)).toBe(true)
    expect(calendarTriggerDue(now - 60000, 0, now - 60000, now)).toBe(false)
    expect(calendarTriggerDue(now + 1, 0, now - 60000, now)).toBe(false)
  })
})
describe('后台任务工具权限', () => {
  it('只用勾选工具，external 总是拒绝，普通写入拒绝', () => {
    expect(taskPermission('send', { level: 'external' }, ['send'], [], false)).toBe(false)
    expect(taskPermission('action_create', { level: 'write' }, ['action_create'], [], false)).toBe(false)
    expect(taskPermission('note_read', { level: 'read' }, [], [], false)).toBe(false)
    expect(taskPermission('note_read', { level: 'read' }, ['note_read'], [], false)).toBe(true)
  })
  it('污点后只能读取或输出，提案在无污点时允许', () => {
    expect(taskPermission('note_append', { level: 'write', proposal: true }, ['note_append'], [], false)).toBe(true)
    expect(taskPermission('note_append', { level: 'write', proposal: true }, ['note_append'], [], true)).toBe(false)
    expect(taskPermission('task_output_inbox', { level: 'write' }, [], ['task_output_inbox'], true)).toBe(true)
    expect(taskPermission('read', { level: 'read', policy: 'ask' }, ['read'], [], false)).toBe(false)
  })
})
