import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Param, SQL } from 'drizzle-orm'
import type { jobs } from '../../db/schema'
import type { JobContext } from '../../services/jobs'

type Row = typeof jobs.$inferSelect
const state = vi.hoisted(() => ({ rows: [] as Row[] }))
function params(sql: unknown): unknown[] {
  if (sql instanceof Param) return [sql.value]
  return sql instanceof SQL ? sql.queryChunks.flatMap(params) : []
}
function matches(row: Row, sql: unknown): boolean {
  const values = params(sql)
  if (values.includes(row.id)) return true
  if (values.includes(row.kind)) return values.includes(row.dedupeKey)
  if (values.includes(row.status)) return !values.some((v) => typeof v === 'number' && row.runAfter > v)
  return values.length === 0
}
vi.mock('../../db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => {
        let condition: unknown
        const query = {
          where: (sql: unknown) => {
            condition = sql
            return query
          },
          orderBy: () => query,
          limit: () => query,
          get: () => state.rows.find((r) => matches(r, condition)),
          all: () => state.rows.filter((r) => matches(r, condition)).map((r) => ({ ...r }))
        }
        return query
      }
    }),
    insert: () => ({ values: (input: Partial<Row>) => ({ run: () => state.rows.push({ ...job(), ...input } as Row) }) }),
    update: () => ({
      set: (patch: Partial<Row>) => ({
        where: (sql: unknown) => ({
          run: () => {
            for (const r of state.rows) if (matches(r, sql)) Object.assign(r, patch)
          }
        })
      })
    }),
    transaction: (fn: () => unknown) => fn()
  })
}))
vi.mock('../../events', () => ({ emit: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn() } }))
import { cancelJob, registerJobKind, retryJob, retryOrEnqueue, startJobs, stopJobs, stopJobsAndWait } from '../../services/jobs'
let counter = 0
const job = (): Row => ({
  id: `job-${++counter}`,
  kind: 'test-cancel',
  payload: '{"itemId":"capture"}',
  status: 'queued',
  progress: 0,
  attempts: 0,
  error: null,
  result: null,
  dedupeKey: null,
  runAfter: 0,
  createdAt: 0,
  updatedAt: 0
})
beforeEach(() => {
  vi.useFakeTimers()
  state.rows = []
})
afterEach(() => {
  stopJobs()
  vi.clearAllTimers()
  vi.useRealTimers()
})
describe('job cancellation coordination', () => {
  it('can drain import checkpoints on quit without waiting for unrelated uninterruptible work', async () => {
    let release!: () => void,
      checkpoint = false,
      drained = false
    const pending = new Promise<void>((r) => {
      release = r
    })
    registerJobKind('test-stalled', {
      title: () => '',
      run: async () => {
        await pending
      }
    })
    registerJobKind('import.run', {
      title: () => '',
      run: async (_payload: unknown, ctx: JobContext) => {
        await new Promise<void>((resolve) => ctx.signal!.addEventListener('abort', () => resolve(), { once: true }))
        checkpoint = true
      }
    })
    state.rows = [
      { ...job(), kind: 'test-stalled' },
      { ...job(), kind: 'import.run' }
    ]
    startJobs()
    const stopping = stopJobsAndWait(['import.run']).then(() => {
      drained = true
    })
    try {
      for (let i = 0; i < 20; i++) await Promise.resolve()
      expect(checkpoint).toBe(true)
      expect(drained).toBe(true)
    } finally {
      release()
      await stopping
      await Promise.resolve()
    }
  })
  it('distinguishes system suspension from explicit cancellation and restarts the interrupted job', async () => {
    let systemInterrupted: boolean | undefined
    const cancel = vi.fn()
    const run = vi
      .fn()
      .mockImplementationOnce(async (_payload: unknown, ctx: JobContext) => {
        await new Promise<void>((resolve) => ctx.signal!.addEventListener('abort', () => resolve(), { once: true }))
        systemInterrupted = (ctx as JobContext & { isInterrupted?: () => boolean }).isInterrupted?.()
      })
      .mockImplementationOnce(async (_payload: unknown, ctx: JobContext) => {
        expect(ctx.isCanceled()).toBe(false)
      })
    registerJobKind('test-cancel', { title: () => '', onCancel: cancel, run })
    const row = job()
    state.rows = [row]
    startJobs()
    await stopJobsAndWait()
    expect(systemInterrupted).toBe(true)
    expect(cancel).not.toHaveBeenCalled()
    expect(row.status).toBe('running')
    startJobs()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    expect(row.status).toBe('done')
  })
  it('notifies queued cancellation without invoking run, and explicit retry clears its cancellation marker', async () => {
    const row = job()
    // 先启动空队列，再加入待取消的任务，确保 handler 尚未执行。
    startJobs()
    state.rows = [row]
    const cancel = vi.fn(),
      retry = vi.fn()
    const run = vi.fn(async (_payload: unknown, ctx: JobContext) => {
      expect(ctx.isCanceled()).toBe(false)
    })
    registerJobKind('test-cancel', { title: () => '', onCancel: cancel, onRetry: retry, run })
    cancelJob(row.id)
    expect(row.status).toBe('canceled')
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ itemId: 'capture' })
    expect(run).not.toHaveBeenCalled()
    retryJob(row.id)
    expect(retry).toHaveBeenCalledExactlyOnceWith({ itemId: 'capture' })
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(row.status).toBe('done')
  })
  it('keeps the old running attempt canceled through immediate retry and starts a clean new attempt after it exits', async () => {
    let resolve!: () => void
    const pending = new Promise<void>((r) => {
      resolve = r
    })
    let oldContext: JobContext | undefined
    const run = vi
      .fn()
      .mockImplementationOnce(async (_payload: unknown, ctx: JobContext) => {
        oldContext = ctx
        await pending
        expect(ctx.isCanceled()).toBe(true)
      })
      .mockImplementationOnce(async (_payload: unknown, ctx: JobContext) => {
        expect(ctx.isCanceled()).toBe(false)
      })
    const cancel = vi.fn()
    registerJobKind('test-cancel', { title: () => '', onCancel: cancel, run })
    const row = job()
    state.rows = [row]
    startJobs()
    expect(row.status).toBe('running')
    cancelJob(row.id)
    retryJob(row.id)
    expect(row.status).toBe('queued')
    expect(oldContext!.isCanceled()).toBe(true)
    resolve()
    await vi.advanceTimersByTimeAsync(1)
    expect(run).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(row.status).toBe('done')
  })
  it('leaves unrelated kinds without a cancellation hook working and ignores stale terminal cancellation', async () => {
    const run = vi.fn(async () => undefined)
    registerJobKind('test-cancel', { title: () => '', run })
    state.rows = []
    startJobs()
    const row = job()
    state.rows = [row]
    cancelJob(row.id)
    expect(row.status).toBe('canceled')
    retryJob(row.id)
    await vi.advanceTimersByTimeAsync(1)
    expect(row.status).toBe('done')
    expect(run).toHaveBeenCalledTimes(1)
    cancelJob(row.id)
    expect(row.status).toBe('done')
  })
})

it('item retry uses complete history, reuses queued/running work and recreates pruned jobs once', async () => {
  const row = { ...job(), status: 'canceled' as const, dedupeKey: 'inbox.recognize:item' }
  const run = vi.fn(async () => undefined)
  registerJobKind('test-cancel', { title: () => '', run })
  startJobs()
  state.rows = [row, ...Array.from({ length: 205 }, () => ({ ...job(), status: 'done' as const, dedupeKey: 'other' }))]
  expect(retryOrEnqueue('test-cancel', {}, row.dedupeKey)).toBe(row.id)
  expect(retryOrEnqueue('test-cancel', {}, row.dedupeKey)).toBe(row.id)
  expect(state.rows.filter((r) => r.status === 'queued')).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(run).toHaveBeenCalledTimes(1)
  state.rows = state.rows.filter((r) => r.id !== row.id)
  const recreated = retryOrEnqueue('test-cancel', {}, row.dedupeKey)
  expect(recreated).not.toBe(row.id)
  expect(retryOrEnqueue('test-cancel', {}, row.dedupeKey)).toBe(recreated)
  const active = state.rows.find((r) => r.id === recreated)!
  active.status = 'running'
  expect(retryOrEnqueue('test-cancel', {}, row.dedupeKey)).toBe(recreated)
  expect(state.rows.filter((r) => r.dedupeKey === row.dedupeKey)).toHaveLength(1)
})
