import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getLoadablePath } from 'sqlite-vec'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { JobContext } from '../../services/jobs'

const f = vi.hoisted(() => ({ sql: null as Database.Database | null, db: null as ReturnType<typeof drizzle> | null }))
vi.mock('../../db', () => ({ getDb: () => f.db, getSqlite: () => f.sql }))
vi.mock('../../events', () => ({ emit: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn() } }))
import * as jobs from '../../services/jobs'

const contexts = new Map<string, JobContext>()
const releases = new Map<string, () => void>()
function hold(name: string, ctx: JobContext): Promise<void> {
  contexts.set(name, ctx)
  return new Promise((resolve) => {
    releases.set(name, resolve)
    ctx.signal!.addEventListener('abort', () => resolve(), { once: true })
  })
}
function row(id: string) {
  return f.sql!.prepare('SELECT * FROM jobs WHERE id=?').get(id) as {
    status: string
    attempts: number
    progress: number
    error: string | null
    run_after: number
    payload: string
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  f.sql = new Database(':memory:')
  f.sql.loadExtension(getLoadablePath())
  for (const file of readdirSync(join(process.cwd(), 'resources/migrations'))
    .filter((p) => p.endsWith('.sql'))
    .sort())
    f.sql.exec(readFileSync(join(process.cwd(), 'resources/migrations', file), 'utf8'))
  f.db = drizzle(f.sql)
  contexts.clear()
  releases.clear()
})
afterEach(async () => {
  await jobs.stopJobsAndWait()
  vi.clearAllTimers()
  vi.useRealTimers()
  f.sql?.close()
})

describe('independent job lanes', () => {
  it.each(['user', 'background'] as const)('a full %s pool cannot delay the other pool or borrow its free slots', async (lane) => {
    const other = lane === 'user' ? 'background' : 'user'
    jobs.registerJobKind<{ name: string }>('lane.full', { lane, title: () => '', run: ({ name }, ctx) => hold(name, ctx) })
    jobs.registerJobKind<{ name: string }>('lane.other', { lane: other, title: () => '', run: ({ name }, ctx) => hold(name, ctx) })
    const ids = [1, 2, 3].map((n) => jobs.enqueue('lane.full', { name: `full-${n}` }))
    jobs.startJobs()
    await vi.advanceTimersByTimeAsync(1)
    expect(ids.map((id) => row(id).status)).toEqual(['running', 'running', 'queued'])
    const immediate = jobs.enqueue('lane.other', { name: 'other' })
    await vi.advanceTimersByTimeAsync(1)
    expect(row(immediate).status).toBe('running')
    expect(row(ids[2]).status).toBe('queued')
  })

  it('a throwing lane resolver falls back to background without breaking dispatch or the waiting projection', async () => {
    jobs.registerJobKind('lane.broken', {
      lane: () => {
        throw new Error('unavailable state')
      },
      title: () => '',
      run: (_, ctx) => hold('broken', ctx)
    })
    jobs.registerJobKind('lane.user', { lane: 'user', title: () => '', run: (_, ctx) => hold('user', ctx) })
    const broken = jobs.enqueue('lane.broken', {})
    const user = jobs.enqueue('lane.user', {})
    jobs.startJobs()
    await vi.advanceTimersByTimeAsync(1)
    expect(row(broken).status).toBe('running')
    expect(row(user).status).toBe('running')
    expect(jobs.listJobs().find((j) => j.id === broken)?.lane).toBe('background')
  })

  it('orders due jobs by priority, then runAfter, then creation time', async () => {
    const started: string[] = []
    const run = ({ name }: { name: string }, ctx: JobContext) => {
      started.push(name)
      return hold(name, ctx)
    }
    jobs.registerJobKind('lane.ordered', { title: () => '', run })
    jobs.registerJobKind('lane.low', { priority: 'low', title: () => '', run })
    jobs.enqueue('lane.ordered', { name: 'later' }, { runAfter: 20 })
    jobs.enqueue('lane.low', { name: 'low' }, { runAfter: 0 })
    jobs.enqueue('lane.ordered', { name: 'earlier' }, { runAfter: 10 })
    jobs.startJobs()
    await vi.advanceTimersByTimeAsync(1)
    expect(started).toEqual(['earlier', 'later'])
  })
})

describe('durable deferral and cooperative yield', () => {
  it('defers without consuming an attempt, clearing steps, progress or the previous error', async () => {
    let first = true,
      generated = 0
    jobs.registerJobKind('lane.defer', {
      title: () => '',
      run: async (_, ctx) => {
        await ctx.step('saved', null, async () => ++generated)
        ctx.progress(0.6)
        if (first) {
          first = false
          throw new jobs.JobDeferred(60_000, 'waiting')
        }
        return 'finished'
      }
    })
    const id = jobs.enqueue('lane.defer', {})
    f.sql!.prepare('UPDATE jobs SET error=? WHERE id=?').run('previous error', id)
    jobs.startJobs()
    await vi.advanceTimersByTimeAsync(1)
    expect(row(id)).toMatchObject({ status: 'queued', attempts: 0, progress: 0.6, error: 'previous error', run_after: 1_060_000 })
    expect(f.sql!.prepare('SELECT output FROM job_steps WHERE job_id=?').all(id)).toEqual([{ output: '1' }])
    expect(jobs.listJobs().find((j) => j.id === id)?.yielded).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(row(id).status).toBe('done')
    expect(row(id).attempts).toBe(1)
    expect(generated).toBe(1)
  })

  it('never requeues a canceled deferral', async () => {
    jobs.registerJobKind('lane.cancel-defer', {
      title: () => '',
      run: async (_, ctx) => {
        await hold('cancel', ctx)
        throw new jobs.JobDeferred(0, 'yield')
      }
    })
    const id = jobs.enqueue('lane.cancel-defer', {})
    jobs.startJobs()
    jobs.cancelJob(id)
    await vi.advanceTimersByTimeAsync(1)
    expect(row(id).status).toBe('canceled')
    expect(jobs.listJobs().find((j) => j.id === id)?.yielded).toBe(false)
  })

  it('yields only after three minutes when another due job in the same lane is waiting', async () => {
    jobs.registerJobKind<{ name: string }>('lane.yield', { title: () => '', run: ({ name }, ctx) => hold(name, ctx) })
    jobs.registerJobKind('lane.different', { lane: 'user', title: () => '', run: (_, ctx) => hold('different', ctx) })
    jobs.enqueue('lane.yield', { name: 'long' })
    jobs.enqueue('lane.yield', { name: 'second' })
    jobs.startJobs()
    const ctx = contexts.get('long')!
    await vi.advanceTimersByTimeAsync(180_001)
    jobs.enqueue('lane.different', {})
    expect(() => ctx.yieldPoint()).not.toThrow()
    jobs.enqueue('lane.yield', { name: 'not-due' }, { runAfter: Date.now() + 60_000 })
    expect(() => ctx.yieldPoint()).not.toThrow()
    jobs.enqueue('lane.yield', { name: 'waiting' })
    await vi.advanceTimersByTimeAsync(5_001)
    expect(() => ctx.yieldPoint()).toThrow(jobs.JobDeferred)
  })

  it('does not yield before the time slice expires even when same-lane work is queued', async () => {
    jobs.registerJobKind<{ name: string }>('lane.before', { title: () => '', run: ({ name }, ctx) => hold(name, ctx) })
    for (const name of ['one', 'two', 'three']) jobs.enqueue('lane.before', { name })
    jobs.startJobs()
    await vi.advanceTimersByTimeAsync(179_999)
    expect(() => contexts.get('one')!.yieldPoint()).not.toThrow()
    await vi.advanceTimersByTimeAsync(1)
    expect(() => contexts.get('one')!.yieldPoint()).toThrow(jobs.JobDeferred)
  })

  it('moves a yielded job behind existing waiters so long jobs take turns and retain progress', async () => {
    const started: string[] = []
    jobs.registerJobKind<{ name: string }>('lane.turns', {
      title: () => '',
      run: async ({ name }, ctx) => {
        started.push(name)
        await hold(name, ctx)
        ctx.progress(0.4)
        ctx.yieldPoint()
      }
    })
    const one = jobs.enqueue('lane.turns', { name: 'one' })
    jobs.enqueue('lane.turns', { name: 'two' })
    const three = jobs.enqueue('lane.turns', { name: 'three' })
    jobs.startJobs()
    await vi.advanceTimersByTimeAsync(180_001)
    releases.get('one')!()
    await vi.advanceTimersByTimeAsync(1)
    expect(started).toEqual(['one', 'two', 'three'])
    expect(row(one)).toMatchObject({ status: 'queued', attempts: 0, progress: 0.4 })
    expect(jobs.listJobs().find((j) => j.id === one)?.yielded).toBe(true)
    releases.get('two')!()
    await vi.advanceTimersByTimeAsync(1)
    expect(started).toEqual(['one', 'two', 'three', 'one'])
    expect(row(three).status).toBe('running')
    expect(row(one).progress).toBe(0.4)
    expect(jobs.listJobs().find((j) => j.id === one)?.yielded).toBe(false)
  })

  it('releases its old lane immediately when the payload resolver changes lanes', async () => {
    let promoted = false,
      runs = 0
    jobs.registerJobKind('lane.promote', {
      lane: () => (promoted ? 'user' : 'background'),
      title: () => '',
      run: async (_, ctx) => {
        runs++
        await hold('promoted', ctx)
        ctx.yieldPoint()
      }
    })
    jobs.registerJobKind('lane.user-block', { lane: 'user', title: () => '', run: (_, ctx) => hold('user-block', ctx) })
    for (let i = 0; i < 2; i++) jobs.enqueue('lane.user-block', {})
    const id = jobs.enqueue('lane.promote', {})
    jobs.startJobs()
    promoted = true
    releases.get('promoted')!()
    await vi.advanceTimersByTimeAsync(1)
    expect(row(id)).toMatchObject({ status: 'queued', attempts: 0 })
    expect(jobs.listJobs().find((j) => j.id === id)?.lane).toBe('user')
    releases.get('user-block')!()
    await vi.advanceTimersByTimeAsync(1)
    expect(row(id).status).toBe('running')
    expect(runs).toBe(2)
  })

  it('a simultaneous stop and yield stays resumable and never commits a failed or done result during shutdown', async () => {
    let resumed = false,
      generated = 0
    jobs.registerJobKind('lane.stop', {
      title: () => '',
      run: async (_, ctx) => {
        await ctx.step('checkpoint', null, async () => ++generated)
        if (!resumed) {
          await hold('stop', ctx)
          throw new jobs.JobDeferred(0, 'yield')
        }
        await hold('resumed', ctx)
      }
    })
    const id = jobs.enqueue('lane.stop', {})
    jobs.startJobs()
    await vi.advanceTimersByTimeAsync(1)
    await jobs.stopJobsAndWait()
    expect(row(id).status).toBe('running')
    expect(f.sql!.prepare('SELECT count(*) n FROM job_steps WHERE job_id=?').get(id)).toEqual({ n: 1 })
    resumed = true
    jobs.startJobs()
    await vi.advanceTimersByTimeAsync(1)
    expect(row(id).status).toBe('running')
    expect(generated).toBe(1)
  })

  it('does not bypass retryOnRestart=false after a simultaneous interruption', async () => {
    jobs.registerJobKind('lane.no-restart', {
      retryOnRestart: false,
      title: () => '',
      run: async (_, ctx) => {
        await hold('no-restart', ctx)
        throw new jobs.JobDeferred(0, 'yield')
      }
    })
    const id = jobs.enqueue('lane.no-restart', {})
    jobs.startJobs()
    await jobs.stopJobsAndWait()
    jobs.startJobs()
    expect(row(id).status).toBe('failed')
  })
})

it('patches queued object payloads only and computes waiting only while queued', async () => {
  jobs.registerJobKind<{ value?: number }>('lane.patch', {
    title: () => '',
    waiting: () => ({ reason: 'parsing' }),
    run: (_, ctx) => hold('patch', ctx)
  })
  const id = jobs.enqueue('lane.patch', { keep: true })
  expect(jobs.patchQueuedPayload(id, { value: 7 })).toBe(true)
  expect(JSON.parse(row(id).payload)).toEqual({ keep: true, value: 7 })
  expect(jobs.listJobs().find((j) => j.id === id)?.waiting).toEqual({ reason: 'parsing' })
  jobs.startJobs()
  expect(jobs.patchQueuedPayload(id, { value: 8 })).toBe(false)
  expect(jobs.listJobs().find((j) => j.id === id)?.waiting).toBeNull()
})
