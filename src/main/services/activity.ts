import { and, eq, gte, sql } from 'drizzle-orm'
import { getDb } from '../db'
import { activity, activityEvents } from '../db/schema'
import { newId } from '../lib/ids'
import { ActivityBatchSchema, type ActivityKind, type ActivityMinutes, type ActivityRef, type ActivitySpan } from '@shared/activity'
import { localDate } from './stats'

// 学习活动记录层（v0.6.7）：今日、计划、洞察、复盘、晨报的统一数据来源。
// 时长类（读、听、写、对话）由渲染进程按“前台 + 最近 60 秒有操作或在播放”累计后每分钟上报；
// 复习、练习、录音由主进程在完成节点记录。数据只在本知识库，不发给模型（晨报只用聚合数字）。

const DAY_LIMIT_MS = 18 * 3600_000

/** 记一条学习活动，同时把有效秒数计入热力图的日汇总。 */
export function recordEvent(
  kind: ActivityKind,
  opts: { refType?: ActivityRef | null; refId?: string | null; durationMs?: number; count?: number; at?: number } = {}
): void {
  const at = opts.at ?? Date.now(),
    date = localDate(new Date(at)),
    durationMs = Math.max(0, Math.round(opts.durationMs ?? 0))
  const db = getDb()
  // 防止异常上报（时钟跳变、重复发送）把一天撑到不合理的时长
  if (durationMs) {
    const today = db
      .select({ ms: sql<number>`coalesce(sum(${activityEvents.durationMs}), 0)` })
      .from(activityEvents)
      .where(and(eq(activityEvents.date, date), eq(activityEvents.kind, kind)))
      .get()?.ms ?? 0
    if (today + durationMs > DAY_LIMIT_MS) return
  }
  db.transaction((tx) => {
    tx.insert(activityEvents)
      .values({ id: newId(), at, date, kind, refType: opts.refType ?? null, refId: opts.refId ?? null, durationMs, count: opts.count ?? 1 })
      .run()
    const seconds = Math.round(durationMs / 1000)
    if (seconds)
      tx.insert(activity)
        .values({ date, kind: 'active_s', count: seconds })
        .onConflictDoUpdate({ target: [activity.date, activity.kind], set: { count: sql`${activity.count} + ${seconds}` } })
        .run()
  })
}

/** 渲染进程每分钟上报的一批有效时长 */
export function trackSpans(raw: unknown): void {
  const spans = ActivityBatchSchema.parse(raw) as ActivitySpan[]
  for (const s of spans) recordEvent(s.kind, { refType: s.refType, refId: s.refId, durationMs: s.durationMs })
}

const emptyMinutes = (): ActivityMinutes => ({ read: 0, listen: 0, write: 0, review: 0, record: 0, practice: 0, chat: 0 })

/** 某天各类有效学习分钟数 */
export function minutesOn(date: string): ActivityMinutes {
  const rows = getDb()
    .select({ kind: activityEvents.kind, ms: sql<number>`sum(${activityEvents.durationMs})` })
    .from(activityEvents)
    .where(eq(activityEvents.date, date))
    .groupBy(activityEvents.kind)
    .all()
  const out = emptyMinutes()
  for (const r of rows) if (r.kind in out) out[r.kind as ActivityKind] = Math.round(r.ms / 60_000)
  return out
}

/** 最近 n 天每天的有效学习分钟数（按时间顺序，含今天） */
export function recentMinutes(days: number): { date: string; minutes: number }[] {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - days + 1)
  const rows = getDb()
    .select({ date: activityEvents.date, ms: sql<number>`sum(${activityEvents.durationMs})` })
    .from(activityEvents)
    .where(gte(activityEvents.date, localDate(start)))
    .groupBy(activityEvents.date)
    .all()
  const map = new Map(rows.map((r) => [r.date, Math.round(r.ms / 60_000)]))
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const key = localDate(d)
    return { date: key, minutes: map.get(key) ?? 0 }
  })
}

/** 清除全部活动记录（设置中可用） */
export function clearActivity(): void {
  getDb().delete(activityEvents).run()
  getDb().delete(activity).where(eq(activity.kind, 'active_s')).run()
}
