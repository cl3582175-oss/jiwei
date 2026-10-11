import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowDownRight, ArrowUpRight, ChevronRight, Download, MessageSquare, RefreshCw, Wallet, X } from 'lucide-react'
import type { UsageBucket, UsageCall, UsageDashboard as Dash, UsageFilter, UsageRange, UsageTotals } from '@shared/agent'
import { FloatingPanel } from '@/components/FloatingPanel'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/primitives'
import { useProviders, useSettings, useUpdateSettings } from '@/lib/queries'
import { useMoney, type Money } from '@/lib/money'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { useTokens } from '../notes/editor/embeds/VisualViews'
import { callerLabel, purposeKey } from './UsageSettings'

// 用量看板（v0.7.5）：用了多少（概览与趋势）、用在哪里（用途、调用方、最贵的几次）、用的哪家（服务商 → 模型），
// 以及月底预测、余额、省钱选项和可导出的明细。金额由主进程按美元记账，这里按显示币种换算。

type Preset = 'today' | 'd7' | 'd30' | 'month' | 'custom'
const pad = (n: number): string => String(n).padStart(2, '0')
const day = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
function presetRange(p: Exclude<Preset, 'custom'>): UsageRange {
  const now = new Date()
  const to = day(now)
  if (p === 'today') return { from: to, to }
  if (p === 'month') return { from: day(new Date(now.getFullYear(), now.getMonth(), 1)), to }
  const n = p === 'd7' ? 6 : 29
  return { from: day(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n)), to }
}

const fmtTokens = (n: number): string =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(2)}B`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`
      : n >= 1e4
        ? `${(n / 1e3).toFixed(1)}K`
        : String(n)
const tokensOf = (x: UsageTotals): number => x.inputTokens + x.outputTokens

/** 用途的显示名：分组名（对话、收件箱整理……）；细分键如 inbox.triage 有自己的名称 */
function usePurposeLabel(): { group: (k: string) => string; raw: (k: string) => string } {
  const { t } = useTranslation()
  const group = (k: string): string => t(`agent.usage.purposes.${k}`, { defaultValue: k })
  const raw = (k: string): string => t(`spend.subPurposes.${k.replace(/[.-]/g, '_')}`, { defaultValue: '' }) || group(purposeKey(k))
  return { group, raw }
}

function Card({
  title,
  hint,
  action,
  children,
  className
}: {
  title?: string
  hint?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('paper rounded-2xl px-5 py-4 shadow-[var(--shadow-1)]', className)}>
      {(title || action) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-medium text-fg">{title}</h2>}
            {hint && <p className="mt-0.5 text-2xs text-subtle">{hint}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

function Delta({ cur, prev }: { cur: number; prev: number }) {
  const { t } = useTranslation()
  // 上一时段没有用量时不显示涨跌（每张卡都写一遍太吵）
  if (prev <= 0) return null
  const pct = ((cur - prev) / prev) * 100
  const up = pct >= 0
  return (
    <Tip label={t('spend.dash.vsPrev')}>
      <span className={cn('inline-flex items-center gap-0.5 text-2xs tabular-nums', up ? 'text-warning' : 'text-accent')}>
        {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
        {Math.abs(pct) >= 1000 ? '>999' : Math.abs(pct).toFixed(Math.abs(pct) < 10 ? 1 : 0)}%
      </span>
    </Tip>
  )
}

function Kpi({ label, value, sub, delta, testId }: { label: string; value: string; sub?: ReactNode; delta?: ReactNode; testId?: string }) {
  return (
    <div className="paper rounded-2xl px-5 py-4 shadow-[var(--shadow-1)]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted">{label}</p>
        {delta}
      </div>
      <p className="mt-1.5 font-serif text-2xl font-semibold text-fg tabular-nums" data-testid={testId}>
        {value}
      </p>
      {sub && <p className="mt-1 truncate text-2xs text-subtle">{sub}</p>}
    </div>
  )
}

/** 每日趋势：按服务商堆叠的柱状图 */
function Trend({ d, colors, money, metric }: { d: Dash; colors: Map<string, string>; money: Money; metric: 'cost' | 'tokens' }) {
  const c = useTokens()
  const el = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!el.current) return
    let disposed = false
    let chart: import('echarts').ECharts | null = null
    const ro = new ResizeObserver(() => chart?.resize())
    ro.observe(el.current)
    const idx = metric === 'cost' ? 0 : 1
    const fmt = (v: number): string => (metric === 'cost' ? money.format(money.toUsd(v)) : fmtTokens(v))
    void import('echarts').then((echarts) => {
      if (disposed || !el.current) return
      chart = echarts.init(el.current, undefined, { renderer: 'svg' })
      chart.setOption({
        animationDuration: 300,
        grid: { left: 8, right: 8, top: 12, bottom: 4, containLabel: true },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow', shadowStyle: { color: c.sunken } },
          backgroundColor: c.surface,
          borderColor: c.border,
          textStyle: { color: c.fg, fontSize: 12 },
          valueFormatter: (v: number) => fmt(v)
        },
        xAxis: {
          type: 'category',
          data: d.days.map((x) => x.date.slice(5)),
          axisLine: { lineStyle: { color: c.border } },
          axisTick: { show: false },
          axisLabel: { color: c.subtle, fontSize: 10, hideOverlap: true }
        },
        yAxis: {
          type: 'value',
          splitNumber: 3,
          splitLine: { lineStyle: { color: c.border, type: 'dashed' } },
          axisLabel: {
            color: c.subtle,
            fontSize: 10,
            formatter: (v: number) => (metric === 'cost' ? money.format(money.toUsd(v), { compact: true }) : fmtTokens(v))
          }
        },
        series: d.providers.map((p, i) => ({
          name: p.name,
          type: 'bar',
          stack: 'all',
          barMaxWidth: 22,
          itemStyle: {
            color: colors.get(p.id),
            borderRadius: i === d.providers.length - 1 ? [3, 3, 0, 0] : 0
          },
          emphasis: { focus: 'series' },
          data: d.days.map((x) => {
            const v = x.providers[p.id]?.[idx] ?? 0
            return metric === 'cost' ? +money.toDisplay(v).toPrecision(6) : v
          })
        }))
      })
    })
    return () => {
      disposed = true
      ro.disconnect()
      chart?.dispose()
    }
  }, [d, c, colors, money, metric])
  return <div ref={el} className="h-[220px] w-full" data-testid="usage-trend" />
}

function Share({
  rows,
  total,
  label,
  color,
  onPick,
  active,
  money,
  testId
}: {
  rows: UsageBucket[]
  total: number
  label: (k: string) => string
  color?: (k: string) => string
  onPick: (k: string) => void
  active?: string | null
  money: Money
  testId?: string
}) {
  const { t } = useTranslation()
  if (!rows.length) return <p className="py-4 text-xs text-subtle">—</p>
  return (
    <ul className="space-y-1" data-testid={testId}>
      {rows.map((r) => {
        const share = total > 0 ? r.cost / total : 0
        return (
          <li key={r.key}>
            <button
              onClick={() => onPick(r.key)}
              className={cn(
                'w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-hover',
                active === r.key && 'bg-accent-soft'
              )}
            >
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  {color && <span className="size-2 shrink-0 rounded-full" style={{ background: color(r.key) }} />}
                  <span className="truncate text-fg">{label(r.key)}</span>
                </span>
                <span className="shrink-0 text-xs text-muted tabular-nums">
                  {r.unpriced === r.calls ? '—' : money.format(r.cost)}
                  <span className="ml-2 text-subtle">{t('spend.dash.calls', { count: r.calls })}</span>
                </span>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-sunken">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.max(1.5, share * 100)}%`, background: color?.(r.key) ?? 'var(--accent)' }}
                />
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function mergeGroups(rows: UsageBucket[]): (UsageBucket & { raws: UsageBucket[] })[] {
  const map = new Map<string, UsageBucket & { raws: UsageBucket[] }>()
  for (const b of rows) {
    const k = purposeKey(b.key)
    const m = map.get(k) ?? { key: k, cost: 0, calls: 0, inputTokens: 0, outputTokens: 0, unpriced: 0, raws: [] }
    m.cost += b.cost
    m.calls += b.calls
    m.inputTokens += b.inputTokens
    m.outputTokens += b.outputTokens
    m.unpriced += b.unpriced
    m.raws.push(b)
    map.set(k, m)
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost || b.calls - a.calls)
}

function Forecast({ d, money }: { d: Dash; money: Money }) {
  const { t } = useTranslation()
  const f = d.forecast
  const spent = (f.projected * f.daysElapsed) / f.daysInMonth
  const scale = Math.max(f.monthlyLimit ?? 0, f.projected, spent, 1e-9)
  const over = f.monthlyLimit !== null && f.projected > f.monthlyLimit
  return (
    <div data-testid="usage-forecast-card">
      <div className="flex items-baseline justify-between">
        <p className="font-serif text-2xl font-semibold text-fg tabular-nums">{money.format(f.projected)}</p>
        <span className="text-2xs text-subtle">{t('spend.dash.dayOf', { day: f.daysElapsed, days: f.daysInMonth })}</span>
      </div>
      <p className="mt-0.5 text-2xs text-muted">{t('spend.dash.projected')}</p>
      <div className="relative mt-4 h-2 rounded-full bg-sunken">
        <div
          className={cn('absolute inset-y-0 left-0 rounded-full', over ? 'bg-warning/35' : 'bg-accent/30')}
          style={{ width: `${(f.projected / scale) * 100}%` }}
        />
        <div
          className={cn('absolute inset-y-0 left-0 rounded-full', over ? 'bg-warning' : 'bg-accent')}
          style={{ width: `${(spent / scale) * 100}%` }}
        />
        {f.monthlyLimit !== null && (
          <div
            className="absolute -top-1 -bottom-1 w-0.5 rounded-full bg-fg/60"
            style={{ left: `calc(${(f.monthlyLimit / scale) * 100}% - 1px)` }}
          />
        )}
      </div>
      <div className="mt-2 flex justify-between text-2xs text-subtle tabular-nums">
        <span>
          {t('spend.dash.spent')} {money.format(spent)}
        </span>
        <span className={cn(over && 'text-warning')}>
          {f.monthlyLimit === null ? t('spend.forecast.noLimit') : `${t('spend.dash.limit')} ${money.format(f.monthlyLimit)}`}
        </span>
      </div>
    </div>
  )
}

function Balances({ money }: { money: Money }) {
  const { t } = useTranslation()
  const { data: providers = [] } = useProviders()
  const eligible = providers.some((p) => (p.kind === 'deepseek' || p.kind === 'moonshot') && p.hasKey)
  const q = useQuery({ queryKey: ['usage', 'balances'], queryFn: () => api.usage.balances(), enabled: eligible, staleTime: 5 * 60_000 })
  return (
    <Card
      title={t('spend.dash.balance')}
      hint={t('spend.dash.balanceHint')}
      action={
        eligible && (
          <Button size="icon-sm" variant="ghost" aria-label={t('spend.dash.balanceRefresh')} onClick={() => void q.refetch()}>
            <RefreshCw className={cn(q.isFetching && 'animate-spin')} />
          </Button>
        )
      }
    >
      {!eligible ? (
        <p className="text-xs leading-relaxed text-subtle">{t('spend.dash.balanceNone')}</p>
      ) : (
        <ul className="space-y-2.5" data-testid="usage-balances">
          {(q.data ?? []).map((b) => (
            <li key={b.providerId} className="flex items-start gap-2.5">
              <Wallet className="mt-0.5 size-4 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm text-fg">{b.name}</span>
                  <span className="shrink-0 font-medium text-fg tabular-nums">
                    {b.ok && b.amount !== undefined ? money.formatIn(b.amount, b.currency ?? 'CNY') : '—'}
                  </span>
                </div>
                <p className={cn('truncate text-2xs', b.ok ? 'text-subtle' : 'text-danger')}>{b.ok ? b.detail : b.error}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function Calls({ filter, money, onClear, chips }: { filter: UsageFilter; money: Money; onClear: () => void; chips: string[] }) {
  const { t } = useTranslation()
  const { raw } = usePurposeLabel()
  const [pages, setPages] = useState(1)
  const key = JSON.stringify(filter)
  useEffect(() => setPages(1), [key])
  const q = useQuery({
    queryKey: ['usage', 'calls', filter, pages],
    queryFn: () => api.usage.calls({ ...filter, limit: 50 * pages, offset: 0 })
  })
  const rows: UsageCall[] = q.data?.rows ?? []
  const exportCsv = async (): Promise<void> => {
    const path = await api.usage.exportCsv(filter)
    if (path) toast.success(t('spend.dash.exported', { path }))
  }
  const time = (at: number): string => {
    const d = new Date(at)
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return (
    <Card
      title={t('spend.dash.detail')}
      hint={q.data ? t('spend.dash.detailCount', { count: q.data.total }) : undefined}
      action={
        <Button size="sm" variant="ghost" onClick={() => void exportCsv()} disabled={!q.data?.total} data-testid="usage-export">
          <Download />
          {t('spend.dash.export')}
        </Button>
      }
    >
      {chips.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5" data-testid="usage-filter">
          {chips.map((c) => (
            <span key={c} className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs text-accent">
              {c}
            </span>
          ))}
          <button
            onClick={onClear}
            className="inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs text-muted hover:bg-surface-hover hover:text-fg"
          >
            <X className="size-3" />
            {t('spend.dash.clearFilter')}
          </button>
        </div>
      )}
      <div className="-mx-2 overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-xs" data-testid="usage-calls">
          <thead className="text-subtle">
            <tr className="border-b border-border">
              {(['time', 'purpose', 'provider', 'model', 'tokens', 'duration', 'cost'] as const).map((k) => (
                <th key={k} className={cn('px-2 pb-2 font-normal', (k === 'cost' || k === 'tokens' || k === 'duration') && 'text-right')}>
                  {t(`spend.dash.col.${k}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.map((r) => (
              <tr key={r.id} className="text-fg">
                <td className="px-2 py-1.5 whitespace-nowrap text-muted tabular-nums">{time(r.at)}</td>
                <td className="px-2 py-1.5">
                  {raw(r.purpose)}
                  {r.caller.startsWith('mcp:') && <span className="ml-1 text-subtle">· {r.caller.slice(4)}</span>}
                </td>
                <td className="px-2 py-1.5 text-muted">{r.providerName ?? '—'}</td>
                <td className="max-w-[180px] truncate px-2 py-1.5 font-mono text-2xs text-muted">{r.model}</td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap text-muted tabular-nums">
                  {fmtTokens(r.inputTokens)} / {fmtTokens(r.outputTokens)}
                </td>
                <td className="px-2 py-1.5 text-right text-muted tabular-nums">
                  {r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}
                </td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">{money.format(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.data && rows.length < q.data.total && (
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => setPages((p) => p + 1)}>
          {t('spend.dash.more')}
        </Button>
      )}
      {q.data && !q.data.total && <p className="py-4 text-center text-xs text-subtle">{t('spend.dash.empty')}</p>}
    </Card>
  )
}

export function UsageDashboard() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const money = useMoney()
  const c = useTokens()
  const { data: s } = useSettings()
  const update = useUpdateSettings()
  const { group, raw } = usePurposeLabel()
  const [preset, setPreset] = useState<Preset>('d30')
  const [custom, setCustom] = useState<UsageRange>(() => presetRange('d30'))
  const range = preset === 'custom' ? custom : presetRange(preset)
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost')
  const [purposeGroup, setPurposeGroup] = useState<string | null>(null)
  const [filter, setFilter] = useState<Omit<UsageFilter, 'from' | 'to'> & { label?: string }>({})
  const { data: d } = useQuery({ queryKey: ['usage', 'dash', range.from, range.to], queryFn: () => api.usage.dashboard(range) })
  useEffect(() => {
    setFilter({})
    setPurposeGroup(null)
  }, [range.from, range.to])

  const colors = useMemo(() => {
    const palette = [c.accent, c.p4, c.p2, c.p5, c.p3, c.p1, c.muted]
    return new Map((d?.providers ?? []).map((p, i) => [p.id, palette[i % palette.length]]))
  }, [d, c])
  const groups = useMemo(() => mergeGroups(d?.byPurpose ?? []), [d])
  const openGroup = groups.find((g) => g.key === purposeGroup)

  const chips: string[] = []
  if (filter.label) chips.push(filter.label)
  const pickFilter = (f: typeof filter): void => setFilter((cur) => (cur.label === f.label ? {} : f))

  const T = d?.totals
  const P = d?.previous
  const cacheRate = T && T.inputTokens > 0 ? T.cachedInputTokens / T.inputTokens : 0
  const ranges: Preset[] = ['today', 'd7', 'd30', 'month', 'custom']

  return (
    <FloatingPanel flushLeft className="flex flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-4 border-b border-border/70 pr-[calc(var(--tb-right)+16px)] pl-8">
        <h1 className="font-serif text-md font-semibold tracking-wide text-fg">{t('spend.dash.title')}</h1>
        <span className="hidden text-xs text-subtle md:inline">{t('spend.dash.subtitle')}</span>
        <div className="no-drag ml-auto flex items-center gap-2">
          {preset === 'custom' && (
            <span className="flex items-center gap-1 text-xs text-muted">
              <input
                type="date"
                value={custom.from}
                max={custom.to}
                aria-label={t('spend.dash.from')}
                onChange={(e) => e.target.value && setCustom((r) => ({ ...r, from: e.target.value }))}
                className="h-7 rounded-md border border-border bg-surface px-1.5 text-xs text-fg outline-none focus:border-accent"
              />
              –
              <input
                type="date"
                value={custom.to}
                min={custom.from}
                max={day(new Date())}
                aria-label={t('spend.dash.to')}
                onChange={(e) => e.target.value && setCustom((r) => ({ ...r, to: e.target.value }))}
                className="h-7 rounded-md border border-border bg-surface px-1.5 text-xs text-fg outline-none focus:border-accent"
              />
            </span>
          )}
          <div className="flex rounded-lg bg-sunken p-0.5" role="radiogroup" aria-label={t('spend.dash.title')}>
            {ranges.map((r) => (
              <button
                key={r}
                role="radio"
                aria-checked={preset === r}
                onClick={() => {
                  if (r === 'custom') setCustom(range)
                  setPreset(r)
                }}
                className={cn(
                  'h-7 rounded-md px-2.5 text-xs transition-colors',
                  preset === r ? 'bg-surface text-fg shadow-[var(--shadow-1)]' : 'text-muted hover:text-fg'
                )}
              >
                {t(`spend.dash.range.${r}`)}
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="usage-dashboard">
        {d && T && P && (
          <div className="mx-auto max-w-[1080px] space-y-4 px-8 pt-6 pb-16">
            {T.unpriced > 0 && (
              <div
                className="flex items-center justify-between gap-3 rounded-xl bg-warning/10 px-4 py-2.5 text-sm text-fg"
                data-testid="usage-unpriced"
              >
                <span>{t('spend.dash.unpriced', { count: T.unpriced })}</span>
                <Button size="sm" variant="ghost" onClick={() => useApp.getState().openSettings('ai')}>
                  {t('spend.dash.fillPrices')}
                  <ChevronRight />
                </Button>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Kpi
                label={t('spend.dash.kpi.cost')}
                value={money.format(T.cost)}
                delta={<Delta cur={T.cost} prev={P.cost} />}
                sub={T.saved > 0 ? `${t('spend.dash.kpi.saved')} ${money.format(T.saved)}` : undefined}
                testId="usage-kpi-cost"
              />
              <Kpi
                label={t('spend.dash.kpi.tokens')}
                value={fmtTokens(tokensOf(T))}
                delta={<Delta cur={tokensOf(T)} prev={tokensOf(P)} />}
                sub={
                  t('spend.dash.kpi.tokensSplit', { input: fmtTokens(T.inputTokens), output: fmtTokens(T.outputTokens) }) +
                  (T.reasoningTokens ? ` · ${t('spend.dash.kpi.reasoning', { n: fmtTokens(T.reasoningTokens) })}` : '')
                }
                testId="usage-kpi-tokens"
              />
              <Kpi
                label={t('spend.dash.kpi.calls')}
                value={String(T.calls)}
                delta={<Delta cur={T.calls} prev={P.calls} />}
                sub={
                  T.calls > T.unpriced ? t('spend.dash.kpi.perCall', { amount: money.format(T.cost / (T.calls - T.unpriced)) }) : undefined
                }
                testId="usage-kpi-calls"
              />
              <Kpi
                label={t('spend.dash.kpi.cache')}
                value={`${Math.round(cacheRate * 100)}%`}
                sub={t('spend.dash.kpi.cacheHint', { n: fmtTokens(T.cachedInputTokens) })}
                testId="usage-kpi-cache"
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
              <Card
                title={t('spend.dash.trend')}
                action={
                  <div className="flex rounded-md bg-sunken p-0.5" role="radiogroup" aria-label={t('spend.dash.trend')}>
                    {(['cost', 'tokens'] as const).map((m) => (
                      <button
                        key={m}
                        role="radio"
                        aria-checked={metric === m}
                        onClick={() => setMetric(m)}
                        className={cn(
                          'h-6 rounded px-2 text-2xs transition-colors',
                          metric === m ? 'bg-surface text-fg shadow-[var(--shadow-1)]' : 'text-muted hover:text-fg'
                        )}
                      >
                        {t(`spend.dash.metric.${m}`)}
                      </button>
                    ))}
                  </div>
                }
              >
                {T.calls ? (
                  <Trend d={d} colors={colors} money={money} metric={metric} />
                ) : (
                  <p className="py-16 text-center text-xs text-subtle">{t('spend.dash.empty')}</p>
                )}
                {d.providers.length > 1 && (
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted">
                    {d.providers.map((p) => (
                      <span key={p.id} className="inline-flex items-center gap-1.5">
                        <span className="size-2 rounded-full" style={{ background: colors.get(p.id) }} />
                        {p.name}
                      </span>
                    ))}
                  </div>
                )}
              </Card>
              <div className="space-y-4">
                <Card title={t('spend.dash.forecast')}>
                  <Forecast d={d} money={money} />
                </Card>
                <Balances money={money} />
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <Card title={t('spend.dash.where')} hint={t('spend.dash.whereHint')}>
                <Share
                  rows={groups}
                  total={T.cost}
                  label={group}
                  money={money}
                  active={purposeGroup}
                  testId="usage-purposes"
                  onPick={(k) => {
                    const g = groups.find((x) => x.key === k)!
                    setPurposeGroup(purposeGroup === k ? null : k)
                    pickFilter({ purposes: g.raws.map((r) => r.key), label: group(k) })
                  }}
                />
                {openGroup && openGroup.raws.length > 1 && (
                  <div className="mt-2 border-t border-border pt-2 pl-3" data-testid="usage-subpurposes">
                    <Share
                      rows={openGroup.raws}
                      total={openGroup.cost}
                      label={raw}
                      money={money}
                      onPick={(k) => pickFilter({ purposes: [k], label: raw(k) })}
                    />
                  </div>
                )}
              </Card>
              <Card title={t('spend.dash.providers')}>
                <ul className="space-y-1" data-testid="usage-providers">
                  {d.providers.map((p) => (
                    <li key={p.id}>
                      <button
                        onClick={() => pickFilter({ providerId: p.id, label: p.name })}
                        className={cn(
                          'w-full rounded-lg px-2 py-1.5 text-left hover:bg-surface-hover',
                          filter.providerId === p.id && !filter.model && 'bg-accent-soft'
                        )}
                      >
                        <div className="flex items-baseline justify-between gap-2 text-sm">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="size-2 shrink-0 rounded-full" style={{ background: colors.get(p.id) }} />
                            <span className="truncate text-fg">{p.name}</span>
                            {p.deleted && <span className="text-2xs text-subtle">{t('spend.dash.deleted')}</span>}
                          </span>
                          <span className="shrink-0 text-xs text-muted tabular-nums">
                            {p.unpriced === p.calls ? '—' : money.format(p.cost)}
                            <span className="ml-2 text-subtle">{T.cost > 0 ? `${Math.round((p.cost / T.cost) * 100)}%` : ''}</span>
                          </span>
                        </div>
                      </button>
                      <ul className="mb-1 ml-6">
                        {p.models.map((m) => (
                          <li key={m.key}>
                            <button
                              onClick={() => pickFilter({ providerId: p.id, model: m.key, label: `${p.name} · ${m.key}` })}
                              className={cn(
                                'flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-0.5 text-left text-xs hover:bg-surface-hover',
                                filter.model === m.key && filter.providerId === p.id && 'bg-accent-soft'
                              )}
                            >
                              <span className="truncate font-mono text-2xs text-muted">{m.key}</span>
                              <span className="shrink-0 text-subtle tabular-nums">
                                {m.unpriced === m.calls ? t('spend.price.unknown') : money.format(m.cost)} ·{' '}
                                {fmtTokens(m.inputTokens + m.outputTokens)}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </Card>
              <div className="space-y-4">
                <Card title={t('spend.dash.who')}>
                  <Share
                    rows={d.byCaller}
                    total={T.cost}
                    label={(k) => callerLabel(k, t)}
                    money={money}
                    active={filter.caller ?? null}
                    testId="usage-callers"
                    onPick={(k) => pickFilter({ caller: k, label: callerLabel(k, t) })}
                  />
                </Card>
                {s && (
                  <Card title={t('spend.dash.save')}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm text-fg">{t('spend.dash.offPeakJobs')}</p>
                        <p className="mt-0.5 text-2xs leading-relaxed text-subtle">{t('spend.dash.offPeakJobsHint')}</p>
                      </div>
                      <Switch
                        checked={s.money.offPeakJobs}
                        aria-label={t('spend.dash.offPeakJobs')}
                        onCheckedChange={(offPeakJobs) =>
                          update.mutate(
                            { money: { ...s.money, offPeakJobs } },
                            { onSuccess: () => void qc.invalidateQueries({ queryKey: ['usage'] }) }
                          )
                        }
                      />
                    </div>
                    {T.saved > 0 && (
                      <p className="mt-3 text-xs text-accent">{t('spend.dash.offPeakSaved', { amount: money.format(T.saved) })}</p>
                    )}
                    <p className="mt-3 text-2xs leading-relaxed text-subtle">{t('spend.dash.cacheTip')}</p>
                  </Card>
                )}
              </div>
            </div>

            <Card title={t('spend.dash.top')} hint={t('spend.dash.topHint')}>
              {d.topRuns.length ? (
                <ol className="divide-y divide-border/60" data-testid="usage-top">
                  {d.topRuns.map((r, i) => {
                    const when = new Date(r.at)
                    return (
                      <li key={r.runId} className="flex items-center gap-3 py-2 text-sm">
                        <span className="w-5 shrink-0 text-center font-serif text-subtle tabular-nums">{i + 1}</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-fg">{r.title || raw(r.purpose)}</p>
                          <p className="truncate text-2xs text-subtle">
                            {`${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`} ·{' '}
                            {raw(r.purpose)} · {callerLabel(r.caller, t)} · {t('spend.dash.calls', { count: r.calls })} ·{' '}
                            {fmtTokens(r.tokens)} tokens · <span className="font-mono">{r.models.join(', ')}</span>
                          </p>
                        </div>
                        <span className="shrink-0 font-medium text-fg tabular-nums">{money.format(r.cost)}</span>
                        {r.conversationId ? (
                          <Tip label={t('spend.dash.openChat')}>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={t('spend.dash.openChat')}
                              onClick={() => useApp.getState().openConversation(r.conversationId)}
                            >
                              <MessageSquare />
                            </Button>
                          </Tip>
                        ) : (
                          <span className="w-7 shrink-0" />
                        )}
                      </li>
                    )
                  })}
                </ol>
              ) : (
                <p className="py-4 text-xs text-subtle">{t('spend.dash.topEmpty')}</p>
              )}
            </Card>

            <Calls
              filter={{ ...range, purposes: filter.purposes, caller: filter.caller, providerId: filter.providerId, model: filter.model }}
              money={money}
              chips={chips}
              onClear={() => {
                setFilter({})
                setPurposeGroup(null)
              }}
            />
          </div>
        )}
      </div>
    </FloatingPanel>
  )
}

/** 花费接近上限时提醒（主进程每天 / 每月各发一次 usage:alert） */
export function useUsageAlerts(): void {
  const { t } = useTranslation()
  const money = useMoney()
  useEffect(
    () =>
      window.jiweiEvents.on('usage:alert', ({ kind, spent, limit }) => {
        toast.warning(
          t('spend.alert.toast', {
            kind: t(`spend.alert.${kind}`),
            pct: Math.floor((spent / limit) * 100),
            spent: money.format(spent),
            limit: money.format(limit)
          }),
          { duration: 10_000, action: { label: t('spend.alert.open'), onClick: () => useApp.getState().openUsage() } }
        )
      }),
    [t, money]
  )
}
