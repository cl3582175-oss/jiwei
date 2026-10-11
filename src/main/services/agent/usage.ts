import { and, eq, gte, sql } from 'drizzle-orm'
import { getDb, getSqlite } from '../../db'
import { aiUsage, meta } from '../../db/schema'
import { newId } from '../../lib/ids'
import { tr } from '../../lib/messages'
import { emit } from '../../events'
import type { Usage } from '@shared/ai'
import { formatAmount } from '@shared/money'
import {
  DEFAULT_BUDGET,
  type Budget,
  type UsageBucket,
  type UsageCall,
  type UsageDashboard,
  type UsageFilter,
  type UsageForecast,
  type UsageProvider,
  type UsageRange,
  type UsageRun,
  type UsageSummary,
  type UsageTotals
} from '@shared/agent'
import { localDate } from '../stats'
import { getSettings } from '../settings'
import { getProviderRow } from '../ai/providers'
import { currentRun, type AgentRun } from './context'
import { costOf, limitUsd } from './pricing'

// AI 调用记账与费用上限。所有模型请求都经过 buildModel() 的中间件，在这里记一条、在请求前检查上限。

const OVERRIDE_KEY = 'budget.override'

export type BudgetKind = 'daily' | 'monthly' | 'run'
export class BudgetError extends Error {
  /** limit 按 currency 计（单次上限在运行开始时已换算为美元） */
  constructor(
    readonly kind: BudgetKind,
    readonly limit: number,
    readonly currency = 'USD'
  ) {
    const amount = formatAmount(limit, currency, getSettings().language)
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

/** 当前是否超限（不含单次）；limit 按上限的币种 */
export function blockedBy(): { kind: 'daily' | 'monthly'; limit: number; currency: string } | null {
  const b = budget()
  if (b.daily === null && b.monthly === null) return null
  if (overrideToday()) return null
  const currency = b.currency ?? 'USD'
  const daily = limitUsd(b.daily, b)
  const monthly = limitUsd(b.monthly, b)
  if (daily !== null && b.daily !== null && spentSince(localDate()) >= daily) return { kind: 'daily', limit: b.daily, currency }
  if (monthly !== null && b.monthly !== null && spentSince(monthStart()) >= monthly) return { kind: 'monthly', limit: b.monthly, currency }
  return null
}

/** 单次上限（美元），在运行开始时换算 */
export function perRunLimit(): number | null {
  const b = budget()
  return limitUsd(b.perRun, b)
}

/** 请求模型前调用：超限时抛出 BudgetError，不发请求 */
export function checkBudget(): void {
  const run = currentRun()
  if (run?.perRun != null && run.state.cost >= run.perRun) {
    const b = budget()
    throw b.perRun !== null ? new BudgetError('run', b.perRun, b.currency ?? 'USD') : new BudgetError('run', run.perRun)
  }
  const blocked = blockedBy()
  if (blocked) throw new BudgetError(blocked.kind, blocked.limit, blocked.currency)
}

/** 花费达到上限的一定比例时提醒一次（每天 / 每月各一次） */
function checkAlerts(): void {
  const at = getSettings().money.alertAt
  if (at === null) return
  const b = budget()
  for (const kind of ['daily', 'monthly'] as const) {
    const limit = limitUsd(b[kind], b)
    if (!limit) continue
    const period = kind === 'daily' ? localDate() : monthStart()
    const key = `budget.alert.${kind}`
    if (getDb().select().from(meta).where(eq(meta.key, key)).get()?.value === period) continue
    const spent = spentSince(period)
    if (spent < at * limit) continue
    getDb()
      .insert(meta)
      .values({ key, value: period })
      .onConflictDoUpdate({ target: meta.key, set: { value: period } })
      .run()
    if (spent < limit) emit('usage:alert', { kind, spent, limit })
  }
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

function providerName(id: string | null): string | null {
  if (!id) return null
  try {
    return getProviderRow(id).name
  } catch {
    return null
  }
}

/** 记一次模型调用；返回估算的费用（美元，价格未知时为 null） */
export function recordUsage(
  providerId: string | null,
  model: string,
  u: Usage,
  run = currentRun(),
  durationMs: number | null = null
): number | null {
  const at = Date.now()
  const { cost, saved } = costOf(providerId, model, u, at)
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
      cost,
      runId: run?.id ?? null,
      conversationId: run?.conversationId ?? null,
      durationMs,
      providerName: providerName(providerId),
      saved
    })
    .run()
  if (run && cost) run.state.cost += cost
  if (cost) checkAlerts()
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
    blocked: blocked?.kind ?? null,
    forecast: forecast(now)
  }
}

/** 按本月节奏估算月底花费：已花 ÷ 已过天数（含今天已过的部分）× 本月天数 */
export function forecast(now = new Date()): UsageForecast {
  const spent = spentSince(monthStart(now))
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  const elapsed = now.getDate() - 1 + (now.getHours() * 60 + now.getMinutes() + 1) / 1440
  const b = budget()
  return {
    projected: elapsed > 0 ? (spent / elapsed) * daysInMonth : spent,
    daysElapsed: now.getDate(),
    daysInMonth,
    monthlyLimit: limitUsd(b.monthly, b)
  }
}

/* ——— 用量看板（v0.7.5） ——— */

const TOTALS = `coalesce(sum(cost), 0) AS cost, count(*) AS calls,
  coalesce(sum(input_tokens), 0) AS inputTokens, coalesce(sum(output_tokens), 0) AS outputTokens,
  coalesce(sum(cached_input_tokens), 0) AS cachedInputTokens, coalesce(sum(reasoning_tokens), 0) AS reasoningTokens,
  coalesce(sum(case when cost is null then 1 else 0 end), 0) AS unpriced, coalesce(sum(saved), 0) AS saved`

const shift = (date: string, days: number): string => {
  const [y, m, d] = date.split('-').map(Number)
  return localDate(new Date(y, m - 1, d + days))
}
const span = (r: UsageRange): number => {
  const [a, b] = [r.from, r.to].map((d) => new Date(`${d}T00:00:00`).getTime())
  return Math.round((b - a) / 86_400_000) + 1
}

function totals(from: string, to: string): UsageTotals {
  return getSqlite().prepare(`SELECT ${TOTALS} FROM ai_usage WHERE date >= ? AND date <= ?`).get(from, to) as UsageTotals
}

function bucketBy(column: 'purpose' | 'caller', r: UsageRange): UsageBucket[] {
  return getSqlite()
    .prepare(
      `SELECT ${column} AS key, coalesce(sum(cost), 0) AS cost, count(*) AS calls, sum(input_tokens) AS inputTokens,
        sum(output_tokens) AS outputTokens, sum(case when cost is null then 1 else 0 end) AS unpriced
       FROM ai_usage WHERE date >= ? AND date <= ? GROUP BY ${column} ORDER BY cost DESC, calls DESC`
    )
    .all(r.from, r.to) as UsageBucket[]
}

/** 服务商键：记账时没有服务商（不应出现）归为 “unknown” */
const providerKey = (id: string | null): string => id ?? 'unknown'

function providersIn(r: UsageRange): UsageProvider[] {
  const rows = getSqlite()
    .prepare(
      `SELECT provider_id AS providerId, max(provider_name) AS name, model AS key, coalesce(sum(cost), 0) AS cost, count(*) AS calls,
        sum(input_tokens) AS inputTokens, sum(output_tokens) AS outputTokens, sum(case when cost is null then 1 else 0 end) AS unpriced
       FROM ai_usage WHERE date >= ? AND date <= ? GROUP BY provider_id, model`
    )
    .all(r.from, r.to) as (UsageBucket & { providerId: string | null; name: string | null })[]
  const map = new Map<string, UsageProvider>()
  for (const row of rows) {
    const id = providerKey(row.providerId)
    let p = map.get(id)
    if (!p) {
      let live: { name: string; kind: string } | null = null
      try {
        live = row.providerId ? getProviderRow(row.providerId) : null
      } catch {
        /* 已删除 */
      }
      p = {
        id,
        name: live?.name ?? row.name ?? tr('未知服务商', 'Unknown provider'),
        kind: live?.kind ?? null,
        deleted: !live,
        cost: 0,
        calls: 0,
        tokens: 0,
        unpriced: 0,
        models: []
      }
      map.set(id, p)
    }
    const { providerId: _id, name: _name, ...bucket } = row
    p.models.push(bucket)
    p.cost += row.cost
    p.calls += row.calls
    p.tokens += row.inputTokens + row.outputTokens
    p.unpriced += row.unpriced
  }
  const list = [...map.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens)
  for (const p of list) p.models.sort((a, b) => b.cost - a.cost || b.calls - a.calls)
  return list
}

function topRuns(r: UsageRange, limit = 10): UsageRun[] {
  const rows = getSqlite()
    .prepare(
      `SELECT u.run_id AS runId, min(u.at) AS at, max(u.purpose) AS purpose, max(u.caller) AS caller,
        max(u.conversation_id) AS conversationId, max(c.title) AS title, coalesce(sum(u.cost), 0) AS cost, count(*) AS calls,
        sum(u.input_tokens + u.output_tokens) AS tokens, group_concat(DISTINCT u.model) AS models
       FROM ai_usage u LEFT JOIN conversations c ON c.id = u.conversation_id
       WHERE u.date >= ? AND u.date <= ? AND u.run_id IS NOT NULL
       GROUP BY u.run_id HAVING sum(u.cost) > 0 ORDER BY cost DESC LIMIT ?`
    )
    .all(r.from, r.to, limit) as (Omit<UsageRun, 'models'> & { models: string | null })[]
  return rows.map((row) => ({ ...row, models: row.models ? row.models.split(',') : [] }))
}

export function dashboard(r: UsageRange): UsageDashboard {
  const days = span(r)
  const prev = { from: shift(r.from, -days), to: shift(r.from, -1) }
  const daily = getSqlite()
    .prepare(
      `SELECT date, provider_id AS providerId, coalesce(sum(cost), 0) AS cost, sum(input_tokens + output_tokens) AS tokens, count(*) AS calls
       FROM ai_usage WHERE date >= ? AND date <= ? GROUP BY date, provider_id`
    )
    .all(r.from, r.to) as { date: string; providerId: string | null; cost: number; tokens: number; calls: number }[]
  const byDate = new Map<string, UsageDashboard['days'][number]>()
  for (let i = 0; i < days; i++) {
    const date = shift(r.from, i)
    byDate.set(date, { date, cost: 0, tokens: 0, calls: 0, providers: {} })
  }
  for (const row of daily) {
    const d = byDate.get(row.date)
    if (!d) continue
    d.cost += row.cost
    d.tokens += row.tokens
    d.calls += row.calls
    d.providers[providerKey(row.providerId)] = [row.cost, row.tokens]
  }
  return {
    range: r,
    totals: totals(r.from, r.to),
    previous: totals(prev.from, prev.to),
    days: [...byDate.values()],
    providers: providersIn(r),
    byPurpose: bucketBy('purpose', r),
    byCaller: bucketBy('caller', r),
    topRuns: topRuns(r),
    forecast: forecast(),
    budget: budget()
  }
}

function where(f: UsageFilter): { sql: string; args: unknown[] } {
  const parts = ['date >= ?', 'date <= ?']
  const args: unknown[] = [f.from, f.to]
  if (f.purposes?.length) {
    parts.push(`purpose IN (${f.purposes.map(() => '?').join(',')})`)
    args.push(...f.purposes)
  }
  if (f.caller) {
    parts.push('caller = ?')
    args.push(f.caller)
  }
  if (f.providerId) {
    parts.push(f.providerId === 'unknown' ? 'provider_id IS NULL' : 'provider_id = ?')
    if (f.providerId !== 'unknown') args.push(f.providerId)
  }
  if (f.model) {
    parts.push('model = ?')
    args.push(f.model)
  }
  return { sql: parts.join(' AND '), args }
}

const CALL_COLUMNS = `id, at, purpose, caller, provider_id AS providerId, provider_name AS providerName, model,
  input_tokens AS inputTokens, output_tokens AS outputTokens, cached_input_tokens AS cachedInputTokens,
  reasoning_tokens AS reasoningTokens, cost, saved, duration_ms AS durationMs, conversation_id AS conversationId`

/** 明细：按时间倒序；total 为符合条件的总条数 */
export function calls(f: UsageFilter): { rows: UsageCall[]; total: number } {
  const w = where(f)
  const db = getSqlite()
  const total = (db.prepare(`SELECT count(*) AS n FROM ai_usage WHERE ${w.sql}`).get(...w.args) as { n: number }).n
  const rows = db
    .prepare(`SELECT ${CALL_COLUMNS} FROM ai_usage WHERE ${w.sql} ORDER BY at DESC LIMIT ? OFFSET ?`)
    .all(...w.args, f.limit ?? 50, f.offset ?? 0) as UsageCall[]
  return { rows, total }
}

/** 导出明细为 CSV（金额同时给出美元与显示币种） */
export function callsCsv(f: UsageFilter, convert: (usd: number) => number, currency: string): string {
  const w = where(f)
  const rows = getSqlite()
    .prepare(`SELECT ${CALL_COLUMNS} FROM ai_usage WHERE ${w.sql} ORDER BY at DESC`)
    .all(...w.args) as UsageCall[]
  const esc = (v: unknown): string => {
    const t = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
  }
  const pad = (n: number): string => String(n).padStart(2, '0')
  const time = (at: number): string => {
    const d = new Date(at)
    return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }
  const head = [
    'time',
    'purpose',
    'caller',
    'provider',
    'model',
    'input_tokens',
    'cached_input_tokens',
    'output_tokens',
    'reasoning_tokens',
    'cost_usd',
    `cost_${currency.toLowerCase()}`,
    'off_peak_saved_usd',
    'duration_ms',
    'conversation_id'
  ]
  const lines = rows.map((r) =>
    [
      time(r.at),
      r.purpose,
      r.caller,
      r.providerName ?? r.providerId ?? '',
      r.model,
      r.inputTokens,
      r.cachedInputTokens,
      r.outputTokens,
      r.reasoningTokens,
      r.cost === null ? '' : r.cost.toFixed(6),
      r.cost === null ? '' : convert(r.cost).toFixed(6),
      r.saved ? r.saved.toFixed(6) : '0',
      r.durationMs ?? '',
      r.conversationId ?? ''
    ]
      .map(esc)
      .join(',')
  )
  // BOM：Excel 打开中文不乱码
  return '\ufeff' + [head.join(','), ...lines].join('\n')
}

export function clearUsage(): void {
  getDb().delete(aiUsage).run()
  emit('usage:changed', {})
}

/** 补算价格：给某服务商的模型填上价格后，之前“价格未知”的调用按调用时间补算（已计价的不改写） */
export function backfillUnpriced(providerId: string): number {
  const db = getSqlite()
  const rows = db
    .prepare(
      `SELECT id, at, model, input_tokens AS inputTokens, output_tokens AS outputTokens, reasoning_tokens AS reasoningTokens,
        cached_input_tokens AS cachedInputTokens FROM ai_usage WHERE provider_id = ? AND cost IS NULL`
    )
    .all(providerId) as ({ id: string; at: number; model: string } & Usage)[]
  const update = db.prepare('UPDATE ai_usage SET cost = ?, saved = ? WHERE id = ?')
  let n = 0
  db.transaction(() => {
    for (const r of rows) {
      const { cost, saved } = costOf(providerId, r.model, r, r.at)
      if (cost === null) continue
      update.run(cost, saved, r.id)
      n++
    }
  })()
  if (n) emit('usage:changed', {})
  return n
}
