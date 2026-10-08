import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'path'
import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm'
import log from 'electron-log/main'
import { getDb } from '../db'
import { jobs } from '../db/schema'
import { newId } from '../lib/ids'
import { emit } from '../events'
import type { Job } from '@shared/types'

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
  worker<T>(task: string, payload: unknown): Promise<T>
  isCanceled(): boolean
}

export interface JobKind<P = unknown> {
  title(payload: P): string
  run(payload: P, ctx: JobContext): Promise<unknown>
}

const kinds = new Map<string, JobKind>()
const running = new Set<string>()
const canceled = new Set<string>()
let timer: NodeJS.Timeout | null = null

export function registerJobKind<P>(kind: string, def: JobKind<P>): void {
  kinds.set(kind, def as JobKind)
}

/* ——— 工作进程 ——— */

let child: UtilityProcess | null = null
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (p: number) => void }>()

function worker(): UtilityProcess {
  if (child) return child
  child = utilityProcess.fork(join(__dirname, 'worker.js'), [], { serviceName: 'jiwei-worker' })
  child.on('message', (msg: { id: string; ok?: boolean; result?: unknown; error?: string; progress?: number }) => {
    const p = pending.get(msg.id)
    if (!p) return
    if (msg.progress !== undefined) return p.onProgress?.(msg.progress)
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error))
  })
  child.on('exit', (code) => {
    log.warn('[jobs] worker exited', code)
    child = null
    for (const [id, p] of pending) {
      p.reject(new Error('Worker exited'))
      pending.delete(id)
    }
  })
  return child
}

function runInWorker<T>(task: string, payload: unknown, onProgress?: (p: number) => void): Promise<T> {
  const id = newId()
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress })
    worker().postMessage({ id, task, payload })
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
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}

export function enqueue(kind: string, payload: unknown, opts?: { dedupeKey?: string }): string {
  const db = getDb()
  if (opts?.dedupeKey) {
    const existing = db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.dedupeKey, opts.dedupeKey), inArray(jobs.status, ['queued', 'running'])))
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
      runAfter: now,
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
  setStatus(r.id, { status: 'running', attempts: r.attempts + 1, progress: 0 })
  let lastEmit = 0
  const ctx: JobContext = {
    progress: (p) => {
      // 进度事件限流
      if (Date.now() - lastEmit < 200 && p < 1) return
      lastEmit = Date.now()
      setStatus(r.id, { progress: Math.max(0, Math.min(1, p)) })
    },
    worker: (task, payload) => runInWorker(task, payload, ctx.progress),
    isCanceled: () => canceled.has(r.id)
  }
  try {
    const result = await kind.run(JSON.parse(r.payload), ctx)
    if (canceled.has(r.id)) return
    setStatus(r.id, { status: 'done', progress: 1, error: null, result: result === undefined ? null : JSON.stringify(result) })
  } catch (e) {
    if (canceled.has(r.id)) return
    const attempts = r.attempts + 1
    const msg = e instanceof Error ? e.message : String(e)
    log.warn('[jobs]', r.kind, r.id, 'failed', attempts, msg)
    if (attempts < MAX_ATTEMPTS) setStatus(r.id, { status: 'queued', error: msg, runAfter: Date.now() + 5000 * 2 ** attempts })
    else setStatus(r.id, { status: 'failed', error: msg })
  } finally {
    running.delete(r.id)
    canceled.delete(r.id)
    setImmediate(tick)
  }
}

function tick(): void {
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
  // 上次退出时仍在运行的任务重新排队
  getDb().update(jobs).set({ status: 'queued', updatedAt: Date.now() }).where(eq(jobs.status, 'running')).run()
  timer = setInterval(tick, TICK_MS)
  tick()
}

export function stopJobs(): void {
  if (timer) clearInterval(timer)
  timer = null
  child?.kill()
  child = null
}

export function listJobs(): Job[] {
  return getDb().select().from(jobs).orderBy(desc(jobs.createdAt)).limit(200).all().map(toJob)
}

export function cancelJob(id: string): void {
  canceled.add(id)
  setStatus(id, { status: 'canceled' })
}

export function retryJob(id: string): void {
  setStatus(id, { status: 'queued', attempts: 0, error: null, runAfter: Date.now() })
  setImmediate(tick)
}

/** 清理 30 天前已完成 / 已取消的任务记录 */
export function pruneJobs(): void {
  getDb()
    .delete(jobs)
    .where(and(inArray(jobs.status, ['done', 'canceled']), lte(jobs.updatedAt, Date.now() - 30 * 86_400_000)))
    .run()
}
