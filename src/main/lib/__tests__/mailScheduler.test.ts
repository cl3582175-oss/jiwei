import { beforeEach, expect, it, vi } from 'vitest'
import { getTableName } from 'drizzle-orm'

const f = vi.hoisted(() => ({
  busy: false,
  poll: vi.fn(),
  queue: vi.fn(),
  writes: [] as { table: string; value: Record<string, unknown> }[]
}))
vi.mock('../../services/mail/imap', () => ({ pollMail: (...args: unknown[]) => f.poll(...args) }))
vi.mock('../../services/tasks/service', () => ({
  listTasks: () => [{ id: 'task', enabled: true, trigger: { type: 'mail', accountId: 'account', from: 'teacher' } }],
  taskBusy: () => f.busy,
  queueTriggeredTask: (...args: unknown[]) => f.queue(...args)
}))
vi.mock('../../db', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ get: () => undefined }) }) }),
    transaction: (fn: () => void) => fn(),
    insert: (table: Parameters<typeof getTableName>[0]) => ({
      values: (value: Record<string, unknown>) => ({
        onConflictDoUpdate: () => ({ run: () => f.writes.push({ table: getTableName(table), value }) })
      })
    })
  })
}))
import { checkMailTriggers } from '../../services/mail/scheduler'
const batch = { validity: 'v1', lastUid: 2, mails: [{ id: 'new-mail', from: 'teacher@example.invalid', subject: 'lesson' }] }
beforeEach(() => {
  f.busy = false
  f.poll.mockReset().mockResolvedValue(batch)
  f.queue.mockReset().mockReturnValue('job')
  f.writes = []
})
it('轮询等待期间启动手动任务，不消费邮件游标；空闲后仍投递同一批次', async () => {
  f.poll.mockImplementationOnce(async () => {
    f.busy = true
    return batch
  })
  await checkMailTriggers(600000)
  expect(f.queue).not.toHaveBeenCalled()
  expect(f.writes).toEqual([])
  f.busy = false
  await checkMailTriggers(660000)
  expect(f.queue).toHaveBeenCalledWith('task', { type: 'mail', accountId: 'account', mailIds: ['new-mail'] })
  expect(f.writes.find((w) => w.table === 'mail_seen')?.value).toMatchObject({ uidValidity: 'v1', lastUid: 2 })
})
it('新负载被拒绝时不写增量游标', async () => {
  f.queue.mockReturnValue(null)
  await checkMailTriggers(600000)
  expect(f.writes.some((w) => w.table === 'mail_seen')).toBe(false)
})
