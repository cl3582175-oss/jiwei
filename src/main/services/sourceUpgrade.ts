import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import log from 'electron-log/main'
import { FORMATS, CURRENT_PARSE_VERSION } from '@shared/formats'
import { getDb, getSqlite } from '../db'
import { assets, jobs, sources } from '../db/schema'
import { onMainEvent } from '../events'
import { getSettings } from './settings'
import { enqueueSegment } from './segmentJobs'
import { cancelJob } from './jobs'

let started = false
let timer: NodeJS.Timeout | null = null
let unsubscribers: (() => void)[] = []
let deferred = false
const eligible = () =>
  getDb()
    .select({ id: sources.id, parseVersion: sources.parseVersion, ext: assets.ext })
    .from(sources)
    .innerJoin(assets, eq(sources.assetId, assets.id))
    .where(
      and(
        isNull(sources.deletedAt),
        eq(sources.aiExcluded, false),
        eq(sources.space, 'library'),
        sql`${sources.kind} NOT IN ('audio','video')`,
        sql`NOT EXISTS (SELECT 1 FROM recordings r WHERE r.source_id=${sources.id})`,
        sql`NOT EXISTS (SELECT 1 FROM source_segments g WHERE g.source_id=${sources.id} AND (g.kind='transcript' OR (${sources.url} IS NOT NULL AND g.kind='slide')))`
      )
    )
    .orderBy(desc(sources.createdAt))
    .all()
    .filter((r) => r.parseVersion >= 0 && !!FORMATS[r.ext]?.parser)

/** 已失败旧资料持久标为 -1；显式重读成功仍会改为当前版本，不自动反复重试。 */
export function scheduleSourceUpgrade(): void {
  if (!started) return
  const db = getDb()
  if (!getSettings().retrieval.autoUpgrade) {
    for (const job of db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, 'source.segment'), eq(jobs.status, 'queued')))
      .all())
      if ((JSON.parse(job.payload) as { upgrade?: boolean }).upgrade) cancelJob(job.id)
    return
  }
  if (
    db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.kind, 'source.segment'), sql`${jobs.status} IN ('queued','running')`))
      .get()
  )
    return
  db.transaction(() => {
    for (const row of eligible()) {
      if (row.parseVersion >= CURRENT_PARSE_VERSION) continue
      const failed = getSqlite()
        .prepare("SELECT 1 FROM jobs WHERE kind='source.segment' AND status='failed' AND json_extract(payload,'$.sourceId')=? LIMIT 1")
        .get(row.id)
      if (row.parseVersion === 0 && failed) {
        db.update(sources).set({ parseVersion: -1 }).where(eq(sources.id, row.id)).run()
        log.warn('[retrieval] skip previously failed source upgrade', row.id)
        continue
      }
      enqueueSegment(row.id, { offPeak: true, upgrade: true })
      break
    }
  })
}

export function sourceUpgradeStatus(): { total: number; done: number; running: boolean; paused: boolean } {
  const rows = eligible(),
    pending = new Set(rows.filter((r) => r.parseVersion < CURRENT_PARSE_VERSION).map((r) => r.id))
  const running = getDb()
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, 'source.segment'), sql`${jobs.status} IN ('queued','running')`))
    .all()
    .some((j) => pending.has((JSON.parse(j.payload) as { sourceId: string }).sourceId))
  return {
    total: rows.length,
    done: rows.filter((r) => r.parseVersion >= CURRENT_PARSE_VERSION).length,
    running,
    paused: !getSettings().retrieval.autoUpgrade
  }
}

const later = (): void => {
  if (deferred) return
  deferred = true
  queueMicrotask(() => {
    deferred = false
    if (started) {
      try {
        scheduleSourceUpgrade()
      } catch (error) {
        // 用户恢复知识库期间连接可暂时关闭；后台升级不能让前台操作崩溃。
        log.warn('[retrieval] source upgrade temporarily unavailable', error)
        timer = setTimeout(later, 60000)
        timer.unref?.()
      }
    }
  })
}
export function startSourceUpgrade(): void {
  stopSourceUpgrade()
  started = true
  const since = Date.now()
  timer = setTimeout(later, 5 * 60 * 1000)
  timer.unref?.()
  unsubscribers = [
    onMainEvent('retrieval:changed', later),
    onMainEvent('jobs:changed', () => {
      // 新资料解析完成或失败后再排下一份；普通索引通知不提前启动升级。
      if (
        getSqlite()
          .prepare("SELECT 1 FROM jobs WHERE kind='source.segment' AND status IN ('done','failed') AND updated_at>=? LIMIT 1")
          .get(since)
      )
        later()
    })
  ]
}
export function stopSourceUpgrade(): void {
  started = false
  if (timer) clearTimeout(timer)
  timer = null
  unsubscribers.forEach((unsubscribe) => unsubscribe())
  unsubscribers = []
}
