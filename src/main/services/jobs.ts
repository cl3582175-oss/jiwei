import { utilityProcess, type UtilityProcess } from 'electron'
import { withRun } from './agent/context'
import { join } from 'path'
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm'
import log from 'electron-log/main'
import { getDb, getSqlite } from '../db'
import { jobs, jobSteps, sources } from '../db/schema'
import { newId } from '../lib/ids'
import { emit } from '../events'
import type { Job, JobWaiting, Lane } from '@shared/types'
import { voiceErrorText } from './voiceMessages'

// 持久化后台任务：
//   - 任务写入 jobs 表，崩溃 / 重启后自动续跑（running → queued）
//   - 失败按指数退避重试（最多 MAX_ATTEMPTS 次）
//   - 耗时计算在 utilityProcess 工作进程中执行，主进程只做调度与落库

const MAX_ATTEMPTS = 3
const POOL = { user: 2, background: 2 } satisfies Record<Lane, number>
const TICK_MS = 1000
const YIELD_AFTER_MS = 180_000

export class JobDeferred extends Error {
  constructor(
    readonly after: number,
    readonly reason: 'yield' | 'waiting'
  ) {
    super(reason)
    this.name = 'JobDeferred'
  }
}

export class PermanentJobError extends Error {
  readonly permanent = true
  constructor(message: string) {
    super(message)
    this.name = 'PermanentJobError'
  }
}
export class TemporaryJobError extends Error {
  readonly temporary = true
  constructor(message: string) {
    super(message)
    this.name = 'TemporaryJobError'
  }
}
function temporary(error: unknown): boolean {
  const e = error as { permanent?: boolean; temporary?: boolean; statusCode?: number; code?: string; message?: string; cause?: unknown }
  if (e?.permanent) return false
  return (
    !!e?.temporary ||
    e?.statusCode === 429 ||
    (e?.statusCode !== undefined && e.statusCode >= 500 && e.statusCode < 600) ||
    /overload|busy|负载|rate limit|network|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(
      `${e?.message ?? ''} ${e?.code ?? ''}`
    ) ||
    (!!e?.cause && e.cause !== error && temporary(e.cause))
  )
}
function waitRetry(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export interface JobContext {
  /** 同一次任务恢复时的交付幂等标识。 */
  readonly jobId?: string
  step<T>(key: string, sourceId: string | null, fn: () => Promise<T>): Promise<T>
  signal?: AbortSignal
  progress(p: number): void
  /** 已持久化一个安全批次后，让同通道的其他任务运行。 */
  yieldPoint(): void
  /** 在工作进程中执行任务 */
  worker<T>(task: string, payload: unknown, signal?: AbortSignal): Promise<T>
  isCanceled(): boolean
  /** System shutdown/pause aborts execution but keeps checkpoints resumable. */
  isInterrupted?(): boolean
}

export interface JobKind<P = unknown> {
  lane?: Lane | ((payload: P) => Lane)
  waiting?(payload: P): JobWaiting | null
  maxAttempts?: number
  retryOnRestart?: boolean
  title(payload: P): string
  run(payload: P, ctx: JobContext): Promise<unknown>
  /** 同步协调领域状态，排队中和运行中的显式取消都会调用。 */
  onCancel?(payload: P): void
  /** 显式重试重新排队时同步领域状态。 */
  onRetry?(payload: P): void
  /** 耗时较长、可以等到低谷时段再跑（v0.7.5，用户开启“低谷时段运行”后生效） */
  offPeak?: boolean
  /** 低优先任务在其他到期任务之后调度，不抢占已经运行的任务。 */
  priority?: 'low'
}

const kinds = new Map<string, JobKind>()
const running = new Map<string, Lane>()
const yielded = new Set<string>()
const canceled = new Set<string>()
const interrupted = new Set<string>()
const controllers = new Map<string, AbortController>()
const executions = new Map<Promise<void>, string>()
let timer: NodeJS.Timeout | null = null
/** 退出时置位：之后不再调度任何任务、不再写库 */
let stopped = false
/** 低谷时段策略：返回最早开始时间（由 index.ts 按设置注入，避免本模块依赖设置与价格） */
let offPeakPolicy: ((at: number) => number) | null = null
export function setOffPeakPolicy(fn: ((at: number) => number) | null): void {
  offPeakPolicy = fn
}

export function registerJobKind<P>(kind: string, def: JobKind<P>): void {
  kinds.set(kind, def as JobKind)
}

/* ——— 工作进程 ——— */

let child: UtilityProcess | null = null
const pending = new Map<
  string,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (p: number) => void; cleanup: () => void }
>()

function worker(): UtilityProcess {
  if (child) return child
  child = utilityProcess.fork(join(__dirname, 'worker.js'), [], { serviceName: 'jiwei-worker' })
  child.on('message', (msg: { id: string; ok?: boolean; result?: unknown; error?: string; progress?: number }) => {
    const p = pending.get(msg.id)
    if (!p) return
    if (msg.progress !== undefined) return p.onProgress?.(msg.progress)
    pending.delete(msg.id)
    p.cleanup()
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error))
  })
  child.on('exit', (code) => {
    log.warn('[jobs] worker exited', code)
    child = null
    for (const [id, p] of pending) {
      p.cleanup()
      p.reject(new Error('Worker exited'))
      pending.delete(id)
    }
  })
  return child
}

export function runInWorker<T>(task: string, payload: unknown, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<T> {
  const id = newId()
  return new Promise<T>((resolve, reject) => {
    signal?.throwIfAborted()
    const process = worker(),
      cancel = (): void => process.postMessage({ cancel: id }),
      cleanup = (): void => signal?.removeEventListener('abort', cancel)
    pending.set(id, {
      resolve: (v) => (signal?.aborted ? reject(new Error('Worker task canceled')) : resolve(v as T)),
      reject,
      cleanup,
      onProgress: (p) => {
        if (!signal?.aborted) onProgress?.(p)
      }
    })
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      process.postMessage({ id, task, payload })
    } catch (error) {
      pending.delete(id)
      cleanup()
      reject(error)
    }
  })
}

/* ——— 队列 ——— */

type Row = typeof jobs.$inferSelect

function laneOf(r: Pick<Row, 'kind' | 'payload'>): Lane {
  try {
    const lane = kinds.get(r.kind)?.lane
    return typeof lane === 'function' ? lane(JSON.parse(r.payload)) : (lane ?? 'background')
  } catch (error) {
    log.warn('[jobs] lane calculation failed', r.kind, error)
    return 'background'
  }
}

function toJob(r: Row): Job {
  let title = r.kind
  let waiting: JobWaiting | null = null
  try {
    title = kinds.get(r.kind)?.title(JSON.parse(r.payload)) ?? r.kind
  } catch {
    /* 保持默认标题 */
  }
  if (r.status === 'queued') {
    try {
      waiting = kinds.get(r.kind)?.waiting?.(JSON.parse(r.payload)) ?? null
    } catch (error) {
      log.warn('[jobs] waiting calculation failed', r.kind, error)
    }
  }
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    progress: r.progress,
    attempts: r.attempts,
    error: r.error,
    title,
    lane: running.get(r.id) ?? laneOf(r),
    waiting,
    yielded: r.status === 'queued' && yielded.has(r.id),
    key: r.dedupeKey,
    runAfter: r.runAfter,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}

export function enqueue(kind: string, payload: unknown, opts?: { dedupeKey?: string; runAfter?: number; offPeak?: boolean }): string {
  const db = getDb()
  // 去重只合并“排队中”的任务：正在运行的任务不会包含它开始之后的变化
  if (opts?.dedupeKey) {
    const existing = db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.dedupeKey, opts.dedupeKey), eq(jobs.status, 'queued')))
      .get()
    if (existing) return existing.id
  }
  const now = Date.now()
  const id = newId()
  let runAfter = opts?.runAfter ?? now
  if ((opts?.offPeak || kinds.get(kind)?.offPeak) && offPeakPolicy) runAfter = Math.max(runAfter, offPeakPolicy(now))
  db.insert(jobs)
    .values({
      id,
      kind,
      payload: JSON.stringify(payload),
      runAfter,
      dedupeKey: opts?.dedupeKey ?? null,
      createdAt: now,
      updatedAt: now
    })
    .run()
  emit('jobs:changed', { ids: [id] })
  setImmediate(tick)
  return id
}

function setStatus(id: string, set: Partial<Row>, notify = true): void {
  if (stopped) return
  if (set.status && !['queued', 'running'].includes(set.status)) yielded.delete(id)
  getDb()
    .update(jobs)
    .set({ ...set, updatedAt: Date.now() })
    .where(eq(jobs.id, id))
    .run()
  if (notify) emit('jobs:changed', { ids: [id] })
}

async function execute(r: Row, lane: Lane): Promise<void> {
  const kind = kinds.get(r.kind)
  if (!kind) {
    setStatus(r.id, { status: 'failed', error: `Unknown job kind: ${r.kind}` })
    return
  }
  running.set(r.id, lane)
  yielded.delete(r.id)
  const abort = new AbortController()
  controllers.set(r.id, abort)
  setStatus(r.id, { status: 'running', attempts: r.attempts + 1 })
  let lastEmit = 0
  const startedAt = Date.now()
  let checkedAt = -Infinity
  let hasWaiter = false
  const identity = getDb()
  const ctx: JobContext = {
    jobId: r.id,
    signal: abort.signal,
    step: async <T>(key: string, sourceId: string | null, fn: () => Promise<T>): Promise<T> => {
      const guard = (): void => {
        abort.signal.throwIfAborted()
        if (stopped || canceled.has(r.id) || getDb() !== identity) throw new Error('canceled')
        if (sourceId) {
          const source = identity.select({ deletedAt: sources.deletedAt }).from(sources).where(eq(sources.id, sourceId)).get()
          if (!source || source.deletedAt !== null) throw new PermanentJobError('Source unavailable')
        }
      }
      guard()
      const saved = identity
        .select()
        .from(jobSteps)
        .where(and(eq(jobSteps.jobId, r.id), eq(jobSteps.stepKey, key)))
        .get()
      if (saved) return JSON.parse(saved.output) as T
      const retry = async <V>(work: () => Promise<V>): Promise<V> => {
        let truncations = 0
        for (let attempt = 0; ; attempt++) {
          guard()
          try {
            return await work()
          } catch (error) {
            guard()
            if (!temporary(error) || attempt >= 3 || ((error as Error)?.name === 'ModelOutputTruncated' && ++truncations > 1)) throw error
            await waitRetry([30_000, 60_000, 120_000][attempt], abort.signal)
          }
        }
      }
      const result = await retry(fn)
      const output = JSON.stringify(result)
      if (output === undefined) throw new PermanentJobError('Step output is not JSON serializable')
      // 生成与落库分开重试：数据库忙时保留本轮已生成的值，不再调用模型。
      await retry(async () => {
        identity.transaction(() => {
          guard()
          identity
            .insert(jobSteps)
            .values({ jobId: r.id, stepKey: key, sourceId, output, createdAt: Date.now() })
            .onConflictDoNothing()
            .run()
        })
      })
      return result
    },
    progress: (p) => {
      // 进度事件限流
      const notify = Date.now() - lastEmit >= 200 || p >= 1
      if (notify) lastEmit = Date.now()
      setStatus(r.id, { progress: Math.max(0, Math.min(1, p)) }, notify)
    },
    yieldPoint: () => {
      abort.signal.throwIfAborted()
      if (laneOf(r) !== lane) throw new JobDeferred(0, 'yield')
      const now = Date.now()
      if (now - startedAt < YIELD_AFTER_MS) return
      if (now - checkedAt >= 5000) {
        // 函数通道依赖当前领域状态，仅读取到期候选的类型和 payload，缓存本通道的计数结果。
        hasWaiter = identity
          .select({ kind: jobs.kind, payload: jobs.payload })
          .from(jobs)
          .where(and(eq(jobs.status, 'queued'), lte(jobs.runAfter, now)))
          .all()
          .some((candidate) => laneOf(candidate) === lane)
        checkedAt = now
      }
      if (hasWaiter) throw new JobDeferred(0, 'yield')
    },
    worker: (task, payload, signal) =>
      runInWorker(task, payload, ctx.progress, signal ? AbortSignal.any([abort.signal, signal]) : abort.signal),
    isCanceled: () => canceled.has(r.id),
    isInterrupted: () => interrupted.has(r.id)
  }
  try {
    const result = await withRun({ purpose: r.kind, caller: 'job' }, () => kind.run(JSON.parse(r.payload), ctx))
    if (canceled.has(r.id)) return
    identity.transaction(() => {
      setStatus(r.id, { status: 'done', progress: 1, error: null, result: result === undefined ? null : JSON.stringify(result) })
      identity.delete(jobSteps).where(eq(jobSteps.jobId, r.id)).run()
    })
  } catch (e) {
    if (canceled.has(r.id)) return
    if (e instanceof JobDeferred) {
      if (e.reason === 'yield') yielded.add(r.id)
      else yielded.delete(r.id)
      setStatus(r.id, { status: 'queued', attempts: r.attempts, runAfter: Date.now() + e.after })
      return
    }
    const attempts = r.attempts + 1
    const msg = voiceErrorText(e)
    log.warn('[jobs]', r.kind, r.id, 'failed', attempts, msg)
    if (!(e as { permanent?: boolean })?.permanent && attempts < (kind.maxAttempts ?? MAX_ATTEMPTS))
      setStatus(r.id, { status: 'queued', error: msg, runAfter: Date.now() + 5000 * 2 ** attempts })
    else setStatus(r.id, { status: 'failed', error: msg })
  } finally {
    running.delete(r.id)
    controllers.delete(r.id)
    canceled.delete(r.id)
    interrupted.delete(r.id)
    setImmediate(tick)
  }
}

function tick(): void {
  if (stopped) return
  const free = { ...POOL }
  for (const lane of running.values()) free[lane]--
  if (free.user <= 0 && free.background <= 0) return
  const low = [...kinds].filter(([, kind]) => kind.priority === 'low').map(([name]) => name)
  const priority = low.length
    ? [
        sql`CASE WHEN ${jobs.kind} IN (${sql.join(
          low.map((name) => sql`${name}`),
          sql`, `
        )}) THEN 1 ELSE 0 END`
      ]
    : []
  const due = getDb()
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, 'queued'), lte(jobs.runAfter, Date.now())))
    .orderBy(...priority, asc(jobs.runAfter), asc(jobs.createdAt))
    .all()
    .filter((r) => !running.has(r.id))
  for (const r of due) {
    const lane = laneOf(r)
    if (free[lane] <= 0) continue
    free[lane]--
    const run = execute(r, lane)
    executions.set(run, r.kind)
    void run.finally(() => executions.delete(run))
  }
}

export function startJobs(): void {
  stopped = false
  yielded.clear()
  getSqlite()
    .prepare('DELETE FROM job_steps WHERE created_at < ? OR job_id NOT IN (SELECT id FROM jobs)')
    .run(Date.now() - 30 * 86_400_000)
  for (const row of getDb().select().from(jobs).where(eq(jobs.status, 'running')).all()) {
    if (kinds.get(row.kind)?.retryOnRestart === false)
      getDb()
        .update(jobs)
        .set({ status: 'failed', error: 'Interrupted; automatic retry is disabled', updatedAt: Date.now() })
        .where(eq(jobs.id, row.id))
        .run()
  }
  // 上次退出时仍在运行的任务重新排队
  getDb().update(jobs).set({ status: 'queued', updatedAt: Date.now() }).where(eq(jobs.status, 'running')).run()
  timer = setInterval(tick, TICK_MS)
  tick()
}

export function stopJobs(): void {
  stopped = true
  // 正在运行的任务标记为取消：它们的后续结果不会再写入
  for (const id of running.keys()) {
    if (!canceled.has(id)) interrupted.add(id)
    canceled.add(id)
  }
  for (const abort of controllers.values()) abort.abort()
  if (timer) clearInterval(timer)
  timer = null
  child?.kill()
  child = null
}
/** 替换数据库或个人档案前，等待工作进程与临时明文清理完成。 */
export async function stopJobsAndWait(kindsToWait?: readonly string[]): Promise<void> {
  stopJobs()
  await Promise.allSettled([...executions].filter(([, kind]) => !kindsToWait || kindsToWait.includes(kind)).map(([run]) => run))
}

export function listJobs(): Job[] {
  return getDb().select().from(jobs).orderBy(desc(jobs.createdAt)).limit(200).all().map(toJob)
}

export function cancelJob(id: string, afterCommit?: (effect: () => void) => void): void {
  const db = getDb()
  const job = db.select().from(jobs).where(eq(jobs.id, id)).get()
  if (!job || (job.status !== 'queued' && job.status !== 'running')) return
  db.transaction(() => {
    setStatus(id, { status: 'canceled' })
    kinds.get(job.kind)?.onCancel?.(JSON.parse(job.payload))
  })
  // 外层生命周期事务可能回滚，不能提前中断仍属于用户的工作。
  const effect = (): void => {
    interrupted.delete(id)
    canceled.add(id)
    controllers.get(id)?.abort()
  }
  if (afterCommit) afterCommit(effect)
  else effect()
}

export function retryJob(id: string): void {
  const db = getDb()
  const job = db.select().from(jobs).where(eq(jobs.id, id)).get()
  if (!job) return
  yielded.delete(id)
  db.transaction(() => {
    setStatus(id, { status: 'queued', attempts: 0, error: null, runAfter: Date.now() })
    kinds.get(job.kind)?.onRetry?.(JSON.parse(job.payload))
  })
  // 排队中取消的任务没有 execute.finally 清理标记；运行中的旧尝试则必须继续保持取消，防止迟到写回。
  if (!running.has(id)) canceled.delete(id)
  setImmediate(tick)
}

/** 排到低谷时段的任务：现在就开始 */
export function runJobNow(id: string): void {
  const job = getDb().select().from(jobs).where(eq(jobs.id, id)).get()
  if (!job || job.status !== 'queued') return
  setStatus(id, { runAfter: Date.now() })
  setImmediate(tick)
}

/** 只合并排队任务的对象 payload，不能改变已经运行的尝试。 */
export function patchQueuedPayload(id: string, patch: Record<string, unknown>): boolean {
  const db = getDb()
  const job = db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.status, 'queued')))
    .get()
  if (!job) return false
  const payload: unknown = JSON.parse(job.payload)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const result = db
    .update(jobs)
    .set({ payload: JSON.stringify({ ...payload, ...patch }), updatedAt: Date.now() })
    .where(and(eq(jobs.id, id), eq(jobs.status, 'queued')))
    .run()
  if (result.changes) emit('jobs:changed', { ids: [id] })
  return result.changes > 0
}

/** 原件恢复使用完整键查找，复用活动任务及取消尝试的迟到结果隔离。 */
export function retryOrEnqueue(kind: string, payload: unknown, dedupeKey: string): string {
  const matching = getDb()
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, kind), eq(jobs.dedupeKey, dedupeKey)))
    .orderBy(desc(jobs.createdAt))
    .all()
  const active = matching.find((job) => job.status === 'queued' || job.status === 'running')
  if (active) return active.id
  const previous = matching.find((job) => job.status === 'canceled' || job.status === 'failed')
  if (previous) {
    retryJob(previous.id)
    return previous.id
  }
  return enqueue(kind, payload, { dedupeKey })
}

/** 清理 30 天前已完成 / 已取消的任务记录 */
export function pruneJobs(): void {
  getDb()
    .delete(jobs)
    .where(and(inArray(jobs.status, ['done', 'canceled']), lte(jobs.updatedAt, Date.now() - 30 * 86_400_000)))
    .run()
  getSqlite().prepare('DELETE FROM job_steps WHERE job_id NOT IN (SELECT id FROM jobs)').run()
}
