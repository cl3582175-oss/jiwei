import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm'
import log from 'electron-log/main'
import { getDb } from '../db'
import { jobs } from '../db/schema'
import { newId } from '../lib/ids'
import { emit } from '../events'
import type { Job } from '@shared/types'
import { voiceErrorText } from './voiceMessages'

// 持久化后台任务：
//   - 任务写入 jobs 表，崩溃 / 重启后自动续跑（running → queued）
//   - 失败按指数退避重试（最多 MAX_ATTEMPTS 次）
//   - 耗时计算在 utilityProcess 工作进程中执行，主进程只做调度与落库

const MAX_ATTEMPTS = 3
const CONCURRENCY = 2
const TICK_MS = 1000

export interface JobContext {
  progress(p: number): void
  /** 在工作进程中执行任务 */
  worker<T>(task: string, payload: unknown, signal?: AbortSignal): Promise<T>
  isCanceled(): boolean
}

export interface JobKind<P = unknown> {
  title(payload: P): string
  run(payload: P, ctx: JobContext): Promise<unknown>
  /** 同步协调领域状态，排队中和运行中的显式取消都会调用。 */
  onCancel?(payload: P): void
  /** 显式重试重新排队时同步领域状态。 */
  onRetry?(payload: P): void
}

const kinds = new Map<string, JobKind>()
const running = new Set<string>()
const canceled = new Set<string>()
const controllers = new Map<string, AbortController>()
let timer: NodeJS.Timeout | null = null
/** 退出时置位：之后不再调度任何任务、不再写库 */
let stopped = false

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

function toJob(r: Row): Job {
  let title = r.kind
  try {
    title = kinds.get(r.kind)?.title(JSON.parse(r.payload)) ?? r.kind
  } catch {
    /* 保持默认标题 */
  }
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    progress: r.progress,
    attempts: r.attempts,
    error: r.error,
    title,
    key: r.dedupeKey,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}

export function enqueue(kind: string, payload: unknown, opts?: { dedupeKey?: string; runAfter?: number }): string {
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
  db.insert(jobs)
    .values({
      id,
      kind,
      payload: JSON.stringify(payload),
      runAfter: opts?.runAfter ?? now,
      dedupeKey: opts?.dedupeKey ?? null,
      createdAt: now,
      updatedAt: now
    })
    .run()
  emit('jobs:changed', { ids: [id] })
  setImmediate(tick)
  return id
}

function setStatus(id: string, set: Partial<Row>): void {
  if (stopped) return
  getDb()
    .update(jobs)
    .set({ ...set, updatedAt: Date.now() })
    .where(eq(jobs.id, id))
    .run()
  emit('jobs:changed', { ids: [id] })
}

async function execute(r: Row): Promise<void> {
  const kind = kinds.get(r.kind)
  if (!kind) {
    setStatus(r.id, { status: 'failed', error: `Unknown job kind: ${r.kind}` })
    return
  }
  running.add(r.id)
  const abort = new AbortController()
  controllers.set(r.id, abort)
  setStatus(r.id, { status: 'running', attempts: r.attempts + 1, progress: 0 })
  let lastEmit = 0
  const ctx: JobContext = {
    progress: (p) => {
      // 进度事件限流
      if (Date.now() - lastEmit < 200 && p < 1) return
      lastEmit = Date.now()
      setStatus(r.id, { progress: Math.max(0, Math.min(1, p)) })
    },
    worker: (task, payload, signal) =>
      runInWorker(task, payload, ctx.progress, signal ? AbortSignal.any([abort.signal, signal]) : abort.signal),
    isCanceled: () => canceled.has(r.id)
  }
  try {
    const result = await kind.run(JSON.parse(r.payload), ctx)
    if (canceled.has(r.id)) return
    setStatus(r.id, { status: 'done', progress: 1, error: null, result: result === undefined ? null : JSON.stringify(result) })
  } catch (e) {
    if (canceled.has(r.id)) return
    const attempts = r.attempts + 1
    const msg = voiceErrorText(e)
    log.warn('[jobs]', r.kind, r.id, 'failed', attempts, msg)
    if (attempts < MAX_ATTEMPTS) setStatus(r.id, { status: 'queued', error: msg, runAfter: Date.now() + 5000 * 2 ** attempts })
    else setStatus(r.id, { status: 'failed', error: msg })
  } finally {
    running.delete(r.id)
    controllers.delete(r.id)
    canceled.delete(r.id)
    setImmediate(tick)
  }
}

function tick(): void {
  if (stopped) return
  const free = CONCURRENCY - running.size
  if (free <= 0) return
  const due = getDb()
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, 'queued'), lte(jobs.runAfter, Date.now())))
    .orderBy(asc(jobs.createdAt))
    .limit(free)
    .all()
    .filter((r) => !running.has(r.id))
  for (const r of due) void execute(r)
}

export function startJobs(): void {
  stopped = false
  // 上次退出时仍在运行的任务重新排队
  getDb().update(jobs).set({ status: 'queued', updatedAt: Date.now() }).where(eq(jobs.status, 'running')).run()
  timer = setInterval(tick, TICK_MS)
  tick()
}

export function stopJobs(): void {
  stopped = true
  // 正在运行的任务标记为取消：它们的后续结果不会再写入
  running.forEach((id) => canceled.add(id))
  for (const abort of controllers.values()) abort.abort()
  if (timer) clearInterval(timer)
  timer = null
  child?.kill()
  child = null
}

export function listJobs(): Job[] {
  return getDb().select().from(jobs).orderBy(desc(jobs.createdAt)).limit(200).all().map(toJob)
}

export function cancelJob(id: string): void {
  const db = getDb()
  const job = db.select().from(jobs).where(eq(jobs.id, id)).get()
  if (!job || (job.status !== 'queued' && job.status !== 'running')) return
  db.transaction(() => {
    setStatus(id, { status: 'canceled' })
    kinds.get(job.kind)?.onCancel?.(JSON.parse(job.payload))
  })
  canceled.add(id)
  controllers.get(id)?.abort()
}

export function retryJob(id: string): void {
  const db = getDb()
  const job = db.select().from(jobs).where(eq(jobs.id, id)).get()
  if (!job) return
  db.transaction(() => {
    setStatus(id, { status: 'queued', attempts: 0, error: null, runAfter: Date.now() })
    kinds.get(job.kind)?.onRetry?.(JSON.parse(job.payload))
  })
  // 排队中取消的任务没有 execute.finally 清理标记；运行中的旧尝试则必须继续保持取消，防止迟到写回。
  if (!running.has(id)) canceled.delete(id)
  setImmediate(tick)
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
}
