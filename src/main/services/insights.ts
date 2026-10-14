import { and, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { Insights, InsightRange } from '@shared/insights'
import { getDb } from '../db'
import {
  activityEvents,
  aiUsage,
  cards,
  decisions,
  feedItems,
  goals,
  mistakes,
  notes,
  planEvents,
  reviewLogs,
  sources,
  workSources,
  works
} from '../db/schema'
import { localDate } from './stats'

// 洞察看板（v0.9，计划 → 复盘 → 洞察）：按学习闭环看一段时间——投入、内化、产出、成本，
// 以及知识漏斗：发现 → 阅读 → 记下 → 掌握 → 运用，看知识在哪一步流失。只读统计，不调用模型。

const DAY = 86400000
/** 稳定度达到 21 天视为“掌握”（进入长期记忆） */
const MASTERED = 21

export function insights(range: InsightRange, now = Date.now()): Insights {
  const db = getDb()
  const to = now,
    from = now - range * DAY,
    prevFrom = from - range * DAY
  const fromDate = localDate(new Date(from)),
    toDate = localDate(new Date(to))

  /* 投入 */
  const byKindRows = db
    .select({ kind: activityEvents.kind, ms: sql<number>`coalesce(sum(${activityEvents.durationMs}), 0)` })
    .from(activityEvents)
    .where(and(gte(activityEvents.date, fromDate), sql`${activityEvents.date} <= ${toDate}`))
    .groupBy(activityEvents.kind)
    .all()
  const byKind: Record<string, number> = {}
  for (const r of byKindRows) if (r.ms > 0) byKind[r.kind] = Math.round(r.ms / 60000)
  const dailyRows = db
    .select({ date: activityEvents.date, ms: sql<number>`coalesce(sum(${activityEvents.durationMs}), 0)` })
    .from(activityEvents)
    .where(and(gte(activityEvents.date, fromDate), sql`${activityEvents.date} <= ${toDate}`))
    .groupBy(activityEvents.date)
    .all()
  const dailyMap = new Map(dailyRows.map((r) => [r.date, Math.round(r.ms / 60000)]))
  const daily: { date: string; minutes: number }[] = []
  for (let d = 0; d < range; d++) {
    const date = localDate(new Date(from + (d + 1) * DAY))
    daily.push({ date, minutes: dailyMap.get(date) ?? 0 })
  }
  const directionRows = db
    .select({ goalId: planEvents.goalId, ms: sql<number>`coalesce(sum(${planEvents.endAt} - ${planEvents.startAt}), 0)` })
    .from(planEvents)
    .where(
      and(
        isNull(planEvents.deletedAt),
        eq(planEvents.status, 'done'),
        eq(planEvents.kind, 'study'),
        isNotNull(planEvents.goalId),
        gte(planEvents.startAt, from),
        lt(planEvents.startAt, to)
      )
    )
    .groupBy(planEvents.goalId)
    .all()
  const goalRows = directionRows.length
    ? db
        .select({ id: goals.id, title: goals.title, color: goals.color })
        .from(goals)
        .where(
          inArray(
            goals.id,
            directionRows.map((r) => r.goalId!)
          )
        )
        .all()
    : []
  const byDirection = directionRows
    .map((r) => {
      const g = goalRows.find((x) => x.id === r.goalId)
      return g ? { goalId: g.id, title: g.title, color: g.color, minutes: Math.round(r.ms / 60000) } : null
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.minutes - a.minutes)

  /* 内化 */
  const retention = (a: number, b: number): { reviews: number; rate: number | null } => {
    const r = db
      .select({ n: sql<number>`count(*)`, ok: sql<number>`coalesce(sum(case when ${reviewLogs.rating} > 1 then 1 else 0 end), 0)` })
      .from(reviewLogs)
      .where(and(gte(reviewLogs.reviewedAt, a), lt(reviewLogs.reviewedAt, b)))
      .get()!
    return { reviews: r.n, rate: r.n ? r.ok / r.n : null }
  }
  const cur = retention(from, to),
    prev = retention(prevFrom, from)
  const weekly: { week: string; rate: number | null }[] = []
  for (let w = Math.ceil(range / 7) - 1; w >= 0; w--) {
    const b = to - w * 7 * DAY,
      a = b - 7 * DAY
    weekly.push({ week: localDate(new Date(a + DAY)), rate: retention(Math.max(a, from), b).rate })
  }
  // 本期新进入长期记忆的卡片：期内有一次复习后稳定度 ≥ 21，且此前从未达到
  const masteredCards = db
    .select({ cardId: reviewLogs.cardId })
    .from(reviewLogs)
    .where(and(gte(reviewLogs.reviewedAt, from), lt(reviewLogs.reviewedAt, to), gte(reviewLogs.stability, MASTERED)))
    .groupBy(reviewLogs.cardId)
    .all()
    .map((r) => r.cardId)
  const earlier = masteredCards.length
    ? new Set(
        db
          .select({ cardId: reviewLogs.cardId })
          .from(reviewLogs)
          .where(and(inArray(reviewLogs.cardId, masteredCards), lt(reviewLogs.reviewedAt, from), gte(reviewLogs.stability, MASTERED)))
          .all()
          .map((r) => r.cardId)
      )
    : new Set<string>()
  const newlyMastered = masteredCards.filter((c) => !earlier.has(c))
  const stableTotal =
    db
      .select({ n: sql<number>`count(*)` })
      .from(cards)
      .where(and(isNull(cards.deletedAt), gte(cards.stability, MASTERED)))
      .get()?.n ?? 0
  const causeRows = db
    .select({ cause: mistakes.cause, n: sql<number>`count(*)` })
    .from(mistakes)
    .where(and(isNull(mistakes.deletedAt), gte(mistakes.createdAt, from), lt(mistakes.createdAt, to)))
    .groupBy(mistakes.cause)
    .all()
  const causes: Record<string, number> = {}
  for (const r of causeRows) causes[r.cause] = r.n

  /* 产出 */
  const worksCreated =
    db
      .select({ n: sql<number>`count(*)` })
      .from(works)
      .where(and(isNull(works.deletedAt), gte(works.createdAt, from), lt(works.createdAt, to)))
      .get()?.n ?? 0
  const worksDone =
    db
      .select({ n: sql<number>`count(*)` })
      .from(works)
      .where(and(isNull(works.deletedAt), eq(works.stage, 'done'), gte(works.updatedAt, from), lt(works.updatedAt, to)))
      .get()?.n ?? 0
  const decisionRows = db
    .select({
      status: decisions.status,
      accuracy: decisions.accuracy,
      memo: decisions.memo,
      updatedAt: decisions.updatedAt,
      createdAt: decisions.createdAt
    })
    .from(decisions)
    .where(and(isNull(decisions.deletedAt), gte(decisions.updatedAt, from), lt(decisions.updatedAt, to)))
    .all()
  const reviewed = decisionRows.filter((d) => d.status === 'reviewed' && d.accuracy)
  const accuracy = reviewed.length ? reviewed.reduce((n, d) => n + d.accuracy!, 0) / reviewed.length : null
  // 运用：期内被作品成品或决策备忘录引用的笔记
  const appliedNotes = new Set(
    db
      .select({ refId: workSources.refId })
      .from(workSources)
      .where(
        and(
          isNull(workSources.deletedAt),
          eq(workSources.used, true),
          eq(workSources.refType, 'note'),
          gte(workSources.updatedAt, from),
          lt(workSources.updatedAt, to)
        )
      )
      .all()
      .map((r) => r.refId)
  )
  for (const d of decisionRows) {
    if (!d.memo || d.createdAt < from) continue
    const memo = JSON.parse(d.memo) as { sources?: { parentType: string; parentId: string }[]; evidence?: { source: string }[] }
    const cited = new Set((memo.evidence ?? []).map((e) => e.source))
    ;(memo.sources ?? []).forEach((s, i) => {
      if (s.parentType === 'note' && cited.has(`S${i + 1}`)) appliedNotes.add(s.parentId)
    })
  }
  const activeNotes =
    db
      .select({ n: sql<number>`count(*)` })
      .from(notes)
      .where(isNull(notes.deletedAt))
      .get()?.n ?? 0

  /* 成本 */
  const costRows = db
    .select({ purpose: aiUsage.purpose, usd: sql<number>`coalesce(sum(${aiUsage.cost}), 0)` })
    .from(aiUsage)
    .where(and(gte(aiUsage.date, fromDate), sql`${aiUsage.date} <= ${toDate}`))
    .groupBy(aiUsage.purpose)
    .all()

  /* 知识漏斗 */
  const discovered =
    (db
      .select({ n: sql<number>`count(*)` })
      .from(feedItems)
      .where(and(isNull(feedItems.deletedAt), gte(feedItems.fetchedAt, from), lt(feedItems.fetchedAt, to)))
      .get()?.n ?? 0) +
    (db
      .select({ n: sql<number>`count(*)` })
      .from(sources)
      .where(and(isNull(sources.deletedAt), eq(sources.space, 'library'), gte(sources.createdAt, from), lt(sources.createdAt, to)))
      .get()?.n ?? 0)
  const read =
    db
      .select({ n: sql<number>`count(distinct coalesce(${activityEvents.refType}, '') || ':' || coalesce(${activityEvents.refId}, ''))` })
      .from(activityEvents)
      .where(
        and(
          inArray(activityEvents.kind, ['read', 'listen']),
          isNotNull(activityEvents.refId),
          gte(activityEvents.date, fromDate),
          sql`${activityEvents.date} <= ${toDate}`
        )
      )
      .get()?.n ?? 0
  const noted =
    db
      .select({ n: sql<number>`count(*)` })
      .from(notes)
      .where(and(isNull(notes.deletedAt), gte(notes.createdAt, from), lt(notes.createdAt, to)))
      .get()?.n ?? 0
  const funnel = [
    { stage: 'discover' as const, count: discovered },
    { stage: 'read' as const, count: read },
    { stage: 'note' as const, count: noted },
    { stage: 'master' as const, count: newlyMastered.length },
    { stage: 'apply' as const, count: appliedNotes.size }
  ]
  // 流失最多的一步：相邻两级转化率最低（上一级为 0 时不算）
  let leak: Insights['leak'] = null
  for (let i = 1; i < funnel.length; i++) {
    const a = funnel[i - 1].count
    if (!a) continue
    const rate = funnel[i].count / a
    if (!leak || rate < leak.rate) leak = { from: funnel[i - 1].stage, to: funnel[i].stage, rate }
  }

  return {
    range,
    from,
    to,
    input: { totalMinutes: Object.values(byKind).reduce((a, b) => a + b, 0), byKind, daily, byDirection },
    internal: {
      reviews: cur.reviews,
      retention: cur.rate,
      retentionPrev: prev.rate,
      weekly,
      newlyMastered: newlyMastered.length,
      stableTotal,
      causes
    },
    output: {
      worksCreated,
      worksDone,
      decisions: decisionRows.length,
      decisionsReviewed: reviewed.length,
      accuracy,
      applied: appliedNotes.size,
      appliedRate: activeNotes ? appliedNotes.size / activeNotes : null
    },
    cost: {
      usd: costRows.reduce((n, r) => n + r.usd, 0),
      byPurpose: costRows.filter((r) => r.usd > 0).map((r) => ({ purpose: r.purpose, usd: r.usd }))
    },
    funnel,
    leak
  }
}
