import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { AiTask } from '@shared/tasks'

const f = vi.hoisted(() => ({
  task: null as AiTask | null,
  state: '{}',
  enqueue: vi.fn(),
  files: ['before.txt', 'new.txt'],
  updates: vi.fn(),
  events: vi.fn()
}))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn() } }))
vi.mock('node:fs/promises', () => ({
  stat: async () => ({ isDirectory: () => true }),
  readdir: async () => f.files.map((name) => ({ name, isFile: () => true }))
}))
vi.mock('../../services/settings', () => ({ getSettings: () => ({ tasks: { paused: false } }) }))
vi.mock('../../services/tasks/service', () => ({
  listTasks: () => [f.task],
  getTask: () => f.task,
  queueTriggeredTask: (...args: unknown[]) => f.enqueue(...args),
  changed: vi.fn()
}))
vi.mock('../../services/plan/calendar', () => ({ events: (...args: unknown[]) => f.events(...args) }))
vi.mock('../../services/progress', () => ({ listGoals: () => [] }))
vi.mock('../../services/mistakes', () => ({ list: () => [{ id: 'new-mistake' }] }))
vi.mock('../../services/webText', () => ({
  fetchWebText: async () => ({ text: 'new text', title: 'Page', sourceUrls: ['https://example.org/'] })
}))
vi.mock('../../services/mail/scheduler', () => ({ checkMailTriggers: vi.fn() }))
vi.mock('../../db', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ get: () => ({ value: f.state }) }) }) }),
    insert: () => ({
      values: (v: { value: string }) => ({
        onConflictDoUpdate: () => ({
          run: () => {
            f.state = v.value
          }
        })
      })
    }),
    update: () => ({ set: (v: unknown) => ({ where: () => ({ run: () => f.updates(v) }) }) })
  })
}))
import { checkTasks } from '../../services/tasks/scheduler'

beforeEach(() => {
  f.task = {
    id: 'task',
    name: 'Task',
    instruction: 'read',
    trigger: { type: 'manual' },
    tools: [],
    outputs: { inbox: true },
    budgetPerRun: null,
    enabled: true,
    recipe: null,
    lastRunAt: null,
    nextRunAt: null,
    lastResult: null,
    monthCost: 0
  }
  f.enqueue.mockReset().mockReturnValue(null)
  f.updates.mockReset()
  f.events.mockReset()
  f.state = '{}'
})
describe('忙碌任务不能消费未接受的来源批次', () => {
  it('文件夹新文件保留到任务空闲，成功入队后才记录', async () => {
    f.task!.trigger = { type: 'folder', path: '/test-folder' }
    f.state = JSON.stringify({ files: ['before.txt'], lastCheck: 1 })
    const now = 600000
    await checkTasks(now)
    expect(JSON.parse(f.state).files).toEqual(['before.txt'])
    f.enqueue.mockReturnValue('job')
    await checkTasks(now + 60000)
    expect(f.enqueue).toHaveBeenLastCalledWith('task', { type: 'folder', path: '/test-folder', files: ['new.txt'] })
    expect(JSON.parse(f.state).files).toEqual(['before.txt', 'new.txt'])
  })
  it('网页更新与错题批次保留，不提前覆盖哈希或已消费ID', async () => {
    f.task!.trigger = { type: 'web', url: 'https://example.org/' }
    f.state = JSON.stringify({ webHash: 'old-hash', lastCheck: 1 })
    await checkTasks(7 * 3600000)
    expect(JSON.parse(f.state).webHash).toBe('old-hash')
    f.enqueue.mockReturnValue('job')
    await checkTasks(8 * 3600000)
    expect(JSON.parse(f.state).webHash).toBe(createHash('sha256').update('new text').digest('hex'))
    f.task!.trigger = { type: 'mistakes', count: 1 }
    f.state = '{}'
    f.enqueue.mockReturnValue(null)
    await checkTasks(9 * 3600000)
    expect(JSON.parse(f.state).mistakeIds).toBeUndefined()
    f.enqueue.mockReturnValue('job')
    await checkTasks(9 * 3600000 + 60000)
    expect(JSON.parse(f.state).mistakeIds).toEqual(['new-mistake'])
  })
  it('零分钟日历跨过开始时刻，并在忙碌后继续投递且不重复', async () => {
    const now = 1000000,
      startAt = now - 23000
    f.task!.trigger = { type: 'calendar', minutesBefore: 0 }
    f.events.mockReturnValue([{ id: 'event', startAt, endAt: now + 60000, title: 'Meeting', kind: 'event', status: 'planned' }])
    await checkTasks(now)
    expect(f.state).toBe('{}')
    f.enqueue.mockReturnValue('job')
    await checkTasks(now + 10000)
    expect(f.enqueue.mock.calls.at(-1)?.[1]).toMatchObject({ type: 'calendar', eventIds: ['event'] })
    expect(JSON.parse(f.state).seen).toEqual([`event:${startAt}`])
    const calls = f.enqueue.mock.calls.length
    await checkTasks(now + 20000)
    expect(f.enqueue).toHaveBeenCalledTimes(calls)
  })
  it('定时任务未入队不推进下一次运行时间', async () => {
    f.task!.trigger = { type: 'interval', minutes: 30 }
    f.task!.nextRunAt = 900000
    await checkTasks(1000000)
    expect(f.updates).not.toHaveBeenCalled()
    expect(f.state).toBe('{}')
    f.enqueue.mockReturnValue('job')
    await checkTasks(1060000)
    expect(f.updates).toHaveBeenCalledWith({ nextRunAt: 2860000, updatedAt: 1060000 })
  })
})
