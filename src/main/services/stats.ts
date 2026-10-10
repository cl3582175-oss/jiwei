import { sql } from 'drizzle-orm'
import { getDb, getSqlite } from '../db'
import { activity } from '../db/schema'
import type { HeatmapDay } from '@shared/types'

export type ActivityKind = 'note_create' | 'note_edit' | 'words' | 'source_add' | 'active_s'

/** 本地日期 YYYY-MM-DD */
export function localDate(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function recordActivity(kind: ActivityKind, amount = 1): void {
  getDb()
    .insert(activity)
    .values({ date: localDate(), kind, count: amount })
    .onConflictDoUpdate({ target: [activity.date, activity.kind], set: { count: sql`${activity.count} + ${amount}` } })
    .run()
}

// 学习强度评分：新建笔记 5 分，每 50 字 1 分，导入资料 2 分，编辑会话按 1/10 计（自动保存频繁），
// 有效学习时长（v0.6.7 活动记录层：读、听、写、复习、录音……）每 10 分钟 1 分
const SCORE_SQL = `
  SUM(CASE kind
    WHEN 'note_create' THEN count * 5
    WHEN 'words' THEN count / 50.0
    WHEN 'source_add' THEN count * 2
    WHEN 'note_edit' THEN count / 10.0
    WHEN 'active_s' THEN count / 600.0
    ELSE 0 END)`

export function heatmap(days: number): HeatmapDay[] {
  const start = new Date()
  start.setDate(start.getDate() - days + 1)
  const rows = getSqlite()
    .prepare(`SELECT date, ROUND(${SCORE_SQL}) AS score FROM activity WHERE date >= ? GROUP BY date`)
    .all(localDate(start)) as { date: string; score: number }[]
  const map = new Map(rows.map((r) => [r.date, r.score]))
  const out: HeatmapDay[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const key = localDate(d)
    out.push({ date: key, count: map.get(key) ?? 0 })
  }
  return out
}
