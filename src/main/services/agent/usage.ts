import { and, eq, gte, sql } from 'drizzle-orm'
import { getDb } from '../../db'
import { aiUsage, meta } from '../../db/schema'
import { newId } from '../../lib/ids'
import { tr } from '../../lib/messages'
import { emit } from '../../events'
import { estimateCost, type Usage } from '@shared/ai'
import { DEFAULT_BUDGET, type Budget, type UsageBucket, type UsageSummary } from '@shared/agent'
import { localDate } from '../stats'
import { getSettings } from '../settings'
import { currentRun, type AgentRun } from './context'

// AI 调用记账与费用上限。所有模型请求都经过 buildModel() 的中间件，在这里记一条、在请求前检查上限。

const OVERRIDE_KEY = 'budget.override'

export type BudgetKind = 'daily' | 'monthly' | 'run'
export class BudgetError extends Error {
  constructor(
    readonly kind: BudgetKind,
    readonly limit: number
  ) {
    const amount = `$${limit >= 0.01 ? limit.toFixed(2) : limit.toPrecision(2)}`
    super(
      `[budget:${kind}] ` +
        (kind === 'daily'
          ? tr(`今天的 AI 花费已达到上限 ${amount}，已暂停。`, `Today's AI spending reached the ${amount} limit and is paused.`)
          : kind === 'monthly'
            ? tr(`本月的 AI 花费已达到上限 ${amount}，已暂停。`, `This month's AI spending reached the ${amount} limit and is paused.`)
            : tr(
                `这次回答的花费已达到单次上限 ${amount}，已暂停后续步骤。`,
                `This answer reached the ${amount} per-answer limit; remaining steps were paused.`
              ))
    )
  }
}
export const isBudgetError = (e: unknown): e is BudgetError =>
  e instanceof BudgetError || (e instanceof Error && /^\[budget:/.test(e.message))

const budget = (): Budget => ({ ...DEFAULT_BUDGET, ...getSettings().budget })
const monthStart = (d = new Date()): string => localDate(new Date(d.getFullYear(), d.getMonth(), 1))

function spentSince(date: string, until?: string): number {
  return (
    getDb()
      .select({ c: sql<number>`coalesce(sum(${aiUsage.cost}), 0)` })
      .from(aiUsage)
      .where(until ? and(gte(aiUsage.date, date), sql`${aiUsage.date} <= ${until}`) : gte(aiUsage.date, date))
      .get()?.c ?? 0
  )
}

function overrideToday(): boolean {
  return getDb().select().from(meta).where(eq(meta.key, OVERRIDE_KEY)).get()?.value === localDate()
}

/** 当前是否超限（不含单次） */
export function blockedBy(): { kind: 'daily' | 'monthly'; limit: number } | null {
  const b = budget()
  if (b.daily === null && b.monthly === null) return null
  if (overrideToday()) return null
  const today = localDate()
  if (b.daily !== null && spentSince(today) >= b.daily) return { kind: 'daily', limit: b.daily }
  if (b.monthly !== null && spentSince(monthStart()) >= b.monthly) return { kind: 'monthly', limit: b.monthly }
  return null
}

/** 请求模型前调用：超限时抛出 BudgetError，不发请求 */
export function checkBudget(): void {
  const run = currentRun()
  if (run?.perRun != null && run.state.cost >= run.perRun) throw new BudgetError('run', run.perRun)
  const blocked = blockedBy()
  if (blocked) throw new BudgetError(blocked.kind, blocked.limit)
}

let lastEmit = 0
let pendingEmit: ReturnType<typeof setTimeout> | null = null
function notify(): void {
  if (pendingEmit) return
  const wait = Math.max(0, 1000 - (Date.now() - lastEmit))
  pendingEmit = setTimeout(() => {
    pendingEmit = null
    lastEmit = Date.now()
    emit('usage:changed', {})
  }, wait)
}

/** 记一次模型调用；返回估算的费用（价格未知时为 null） */
export function recordUsage(providerId: string | null, model: string, u: Usage, run = currentRun()): number | null {
  const cost = estimateCost(model, u)
  const at = Date.now()
  getDb()
    .insert(aiUsage)
    .values({
      id: newId(),
      at,
      date: localDate(new Date(at)),
      purpose: run?.purpose ?? 'other',
      caller: run?.caller ?? 'app',
      providerId,
      model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      reasoningTokens: u.reasoningTokens,
      cachedInputTokens: u.cachedInputTokens,
      cost
    })
    .run()
  if (run && cost) run.state.cost += cost
  notify()
  return cost
}

export type { AgentRun }

/** 达到每日 / 每月上限后，用户选择“今天继续使用” */
export function allowToday(): void {
  const value = localDate()
  getDb().insert(meta).values({ key: OVERRIDE_KEY, value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run()
  emit('usage:changed', {})
}

function buckets(column: typeof aiUsage.purpose | typeof aiUsage.model, since: string): UsageBucket[] {
  return getDb()
    .select({
      key: column,
      cost: sql<number>`coalesce(sum(${aiUsage.cost}), 0)`,
      calls: sql<number>`count(*)`,
      inputTokens: sql<number>`sum(${aiUsage.inputTokens})`,
      outputTokens: sql<number>`sum(${aiUsage.outputTokens})`,
      unpriced: sql<number>`sum(case when ${aiUsage.cost} is null then 1 else 0 end)`
    })
    .from(aiUsage)
    .where(gte(aiUsage.date, since))
    .groupBy(column)
    .all()
    .sort((a, b) => b.cost - a.cost || b.calls - a.calls)
}

export function usageSummary(): UsageSummary {
  const db = getDb()
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)
  const from = localDate(start)
  const rows = db
    .select({ date: aiUsage.date, cost: sql<number>`coalesce(sum(${aiUsage.cost}), 0)`, calls: sql<number>`count(*)` })
    .from(aiUsage)
    .where(gte(aiUsage.date, from))
    .groupBy(aiUsage.date)
    .all()
  const byDate = new Map(rows.map((r) => [r.date, r]))
  const days = Array.from({ length: 30 }, (_, i) => {
    const date = localDate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i))
    return { date, cost: byDate.get(date)?.cost ?? 0, calls: byDate.get(date)?.calls ?? 0 }
  })
  const month = monthStart(now)
  const byPurpose = buckets(aiUsage.purpose, month)
  const blocked = blockedBy()
  return {
    today: spentSince(localDate(now)),
    month: spentSince(month),
    calls: byPurpose.reduce((s, b) => s + b.calls, 0),
    unpriced: byPurpose.reduce((s, b) => s + b.unpriced, 0),
    days,
    byPurpose,
    byModel: buckets(aiUsage.model, month),
    budget: budget(),
    overrideToday: overrideToday(),
    blocked: blocked?.kind ?? null
  }
}

export function clearUsage(): void {
  getDb().delete(aiUsage).run()
  emit('usage:changed', {})
}
