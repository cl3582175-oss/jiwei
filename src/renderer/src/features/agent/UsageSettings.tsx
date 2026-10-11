import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { BarChart3, Download, PauseCircle, RefreshCw, Trash2 } from 'lucide-react'
import type { AuditEntry, Budget, UsageBucket } from '@shared/agent'
import { currencyName, currencySymbol, DEFAULT_RATES, DEFAULT_RATES_AT, rateOf, toUsd, fromUsd } from '@shared/money'
import { useMoney, type Money } from '@/lib/money'
import { useApp } from '@/store/app'
import { Switch } from '@/components/ui/switch'
import { CurrencyPicker } from './CurrencyPicker'
import { Button } from '@/components/ui/button'
import { confirm } from '@/components/ui/confirm'
import { Tip } from '@/components/ui/primitives'
import { useSettings, useUpdateSettings } from '@/lib/queries'
import { api, cn } from '@/lib/utils'

// 设置 → 费用与权限（v0.7）：本月花费、每日柱状图、分项、上限、最近做了什么（审计日志）。

/** 用途键（含后台任务类型，如 inbox.triage、mistake-split）→ 分组名 */
export function purposeKey(p: string): string {
  if (p.startsWith('mistake')) return 'mistakes'
  if (p.startsWith('inbox')) return 'inbox'
  if (p.startsWith('lens') || p.startsWith('source.')) return p.includes('recognize') ? 'recognize' : 'lens'
  if (p.includes('recognize')) return 'recognize'
  if (p.startsWith('course')) return 'course'
  if (p.startsWith('recording')) return 'recording'
  return p.split('.')[0]
}

export function callerLabel(caller: string, t: (k: string) => string): string {
  if (caller.startsWith('mcp:')) return caller.slice(4)
  return ['assistant', 'job', 'app'].includes(caller) ? t(`agent.usage.callers.${caller}`) : caller
}

function Section({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-border py-5 last:border-0">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-fg">{title}</h3>
          {hint && <p className="mt-1 max-w-[460px] text-xs leading-relaxed text-muted">{hint}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

function Buckets({ title, rows, label, money }: { title: string; rows: UsageBucket[]; label: (k: string) => string; money: Money }) {
  const { t } = useTranslation()
  const max = Math.max(...rows.map((r) => r.cost), 0.000001)
  return (
    <div className="min-w-0">
      <p className="mb-2 text-xs text-subtle">{title}</p>
      <ul className="space-y-2">
        {rows.slice(0, 8).map((r) => (
          <li key={r.key} className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-fg">{label(r.key)}</span>
              <span className="shrink-0 text-xs text-muted tabular-nums">
                {r.unpriced === r.calls ? '—' : money.format(r.cost)} · {t('agent.usage.calls', { count: r.calls })}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-sunken">
              <div className="h-full rounded-full bg-accent/70" style={{ width: `${Math.max(2, (r.cost / max) * 100)}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function LimitInput({
  label,
  hint,
  value,
  symbol,
  onSave
}: {
  label: string
  hint?: string
  value: number | null
  symbol: string
  onSave: (v: number | null) => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState(value === null ? '' : String(value))
  useEffect(() => setText(value === null ? '' : String(value)), [value])
  const commit = (): void => {
    const v = text.trim() === '' ? null : Number(text)
    if (v !== null && (!Number.isFinite(v) || v < 0)) return setText(value === null ? '' : String(value))
    if (v !== value) onSave(v === null ? null : Math.round(v * 100) / 100)
  }
  return (
    <label className="block">
      <span className="text-sm text-fg">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-subtle">{hint}</span>}
      <span className="mt-1.5 flex h-9 items-center rounded-lg border border-border bg-surface px-3 focus-within:border-accent">
        <span className="text-sm text-subtle">{symbol}</span>
        <input
          inputMode="decimal"
          value={text}
          placeholder={t('agent.usage.none')}
          aria-label={label}
          onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ''))}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
          className="ml-1 w-full min-w-0 bg-transparent text-sm text-fg tabular-nums outline-none placeholder:text-subtle"
        />
      </span>
    </label>
  )
}

function AuditRow({ e }: { e: AuditEntry }) {
  const { t } = useTranslation()
  const d = new Date(e.at)
  return (
    <li className="flex items-start gap-3 py-2 text-sm" data-testid="audit-row">
      <span className="w-[88px] shrink-0 text-xs text-subtle tabular-nums">
        {`${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`}
      </span>
      <span className="w-[96px] shrink-0 truncate text-xs text-muted">{callerLabel(e.caller, t)}</span>
      <span className="min-w-0 flex-1 break-words text-fg">{e.summary}</span>
      <span
        className={cn(
          'shrink-0 rounded-full px-2 py-px text-xs',
          e.status === 'ok' ? 'bg-accent-soft text-accent' : e.status === 'denied' ? 'bg-sunken text-muted' : 'bg-danger-soft text-danger'
        )}
      >
        {t(`agent.usage.status.${e.status}`)}
      </span>
    </li>
  )
}

/** 币种与汇率：显示币种、1 美元兑换多少、联网更新 */
function CurrencySection() {
  const { t, i18n } = useTranslation()
  const { data: s } = useSettings()
  const update = useUpdateSettings()
  const [pending, setPending] = useState<string | null>(null)
  const [rateText, setRateText] = useState('')
  const [busy, setBusy] = useState(false)
  const m = s?.money
  const code = pending ?? m?.currency ?? 'USD'
  const rate = m ? rateOf(code, m) : null
  useEffect(() => setRateText(rate ? String(+rate.toPrecision(6)) : ''), [rate, code])
  if (!m) return null
  const locale = i18n.language
  const choose = (next: string): void => {
    if (next === m.currency) return setPending(null)
    if (!rateOf(next, m)) return setPending(next)
    setPending(null)
    update.mutate(
      { money: { ...m, currency: next } },
      { onSuccess: () => toast.success(t('spend.currency.switched', { name: currencyName(next, locale) })) }
    )
  }
  const saveRate = (): void => {
    const v = Number(rateText)
    if (!Number.isFinite(v) || v <= 0) return setRateText(rate ? String(+rate.toPrecision(6)) : '')
    if (rate && Math.abs(v - rate) < 1e-9 && !pending) return
    const money = { ...m, rates: { ...m.rates, [code]: v }, ratesAt: null, ...(pending ? { currency: pending } : {}) }
    update.mutate(
      { money },
      { onSuccess: () => pending && toast.success(t('spend.currency.switched', { name: currencyName(code, locale) })) }
    )
    setPending(null)
  }
  const fetchRates = async (): Promise<void> => {
    setBusy(true)
    try {
      const next = await api.usage.updateRates()
      toast.success(t('spend.currency.updated'))
      if (pending && rateOf(pending, next)) choose(pending)
    } catch (e) {
      toast.error(
        t('spend.currency.updateFailed', {
          msg: e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
        })
      )
    } finally {
      setBusy(false)
    }
  }
  const custom = m.rates[code] !== undefined
  const source =
    code === 'USD'
      ? ''
      : !custom
        ? t('spend.currency.builtin', { date: new Date(DEFAULT_RATES_AT).toLocaleDateString(locale) })
        : m.ratesAt
          ? t('spend.currency.online', { time: new Date(m.ratesAt).toLocaleString(locale) })
          : t('spend.currency.manual')
  return (
    <Section title={t('spend.currency.title')} hint={t('spend.currency.hint')}>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3" data-testid="currency-section">
        <CurrencyPicker value={code} onChange={choose} label={t('spend.currency.display')} testId="currency-picker" />
        {code !== 'USD' && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted">{t('spend.currency.rate')}</span>
            <span className="flex h-9 items-center rounded-lg border border-border bg-surface px-3 focus-within:border-accent">
              <input
                inputMode="decimal"
                value={rateText}
                aria-label={t('spend.currency.rate')}
                data-testid="currency-rate"
                onChange={(e) => setRateText(e.target.value.replace(/[^\d.]/g, ''))}
                onBlur={saveRate}
                onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
                className="w-24 bg-transparent text-sm text-fg tabular-nums outline-none"
              />
              <span className="ml-1 text-xs text-subtle">{currencySymbol(code, locale)}</span>
            </span>
            {custom && DEFAULT_RATES[code] && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const { [code]: _drop, ...rest } = m.rates
                  update.mutate({ money: { ...m, rates: rest } })
                }}
              >
                {t('spend.currency.reset')}
              </Button>
            )}
          </div>
        )}
      </div>
      {pending && !rate && <p className="mt-2 text-xs text-warning">{t('spend.currency.needRate', { code: pending })}</p>}
      {source && <p className="mt-2 text-xs text-subtle">{source}</p>}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-fg">{t('spend.currency.auto')}</p>
          <p className="mt-0.5 max-w-[420px] text-xs text-subtle">{t('spend.currency.autoHint')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void fetchRates()}>
            <RefreshCw className={cn(busy && 'animate-spin')} />
            {t('spend.currency.update')}
          </Button>
          <Switch
            checked={m.autoRates}
            aria-label={t('spend.currency.auto')}
            onCheckedChange={(autoRates) => update.mutate({ money: { ...m, autoRates } })}
          />
        </div>
      </div>
    </Section>
  )
}

export function UsageSettings() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: s } = useSettings()
  const update = useUpdateSettings()
  const money = useMoney()
  const { data: u } = useQuery({ queryKey: ['usage'], queryFn: () => api.usage.summary() })
  const [caller, setCaller] = useState<string>('')
  const [more, setMore] = useState(false)
  const { data: callers = [] } = useQuery({ queryKey: ['audit', 'callers'], queryFn: () => api.agent.auditCallers() })
  const { data: audit = [] } = useQuery({
    queryKey: ['audit', caller, more],
    queryFn: () => api.agent.audit({ caller: caller || undefined, limit: more ? 500 : 30 })
  })
  if (!u || !s) return null
  // 上限按显示币种填写；更早的设置按美元保存，显示时先换算
  const stored: Budget = s.budget
  const bc = stored.currency ?? 'USD'
  const inDisplay = (v: number | null): number | null => {
    if (v === null || bc === money.currency) return v
    const usdV = toUsd(v, bc, s.money)
    if (usdV === null) return v
    const x = fromUsd(usdV, money.currency, s.money)
    return x >= 100 ? Math.round(x) : Math.round(x * 100) / 100
  }
  const budget: Budget = {
    perRun: inDisplay(stored.perRun),
    daily: inDisplay(stored.daily),
    monthly: inDisplay(stored.monthly),
    currency: money.currency
  }
  const save = (patch: Partial<Budget>): void =>
    update.mutate({ budget: { ...budget, ...patch } }, { onSuccess: () => void qc.invalidateQueries({ queryKey: ['usage'] }) })
  const f = u.forecast
  const maxDay = Math.max(...u.days.map((d) => d.cost), 0.000001)
  const purpose = (k: string): string => {
    const g = purposeKey(k)
    return t(`agent.usage.purposes.${g}`, { defaultValue: k })
  }

  const clearUsage = async (): Promise<void> => {
    if (
      !(await confirm({
        title: t('agent.usage.clearTitle'),
        description: t('agent.usage.clearDesc'),
        danger: true,
        confirmText: t('agent.usage.clear')
      }))
    )
      return
    await api.usage.clear()
    toast.success(t('agent.usage.cleared'))
  }
  const clearAudit = async (): Promise<void> => {
    if (
      !(await confirm({
        title: t('agent.usage.clearAuditTitle'),
        description: t('agent.usage.clearAuditDesc'),
        danger: true,
        confirmText: t('agent.usage.clearAudit')
      }))
    )
      return
    await api.agent.clearAudit()
  }
  const exportAudit = async (): Promise<void> => {
    const path = await api.agent.exportAudit()
    if (path) toast.success(t('agent.usage.exported', { path }))
  }
  // 合并后台任务类型到用途分组
  const merged = new Map<string, UsageBucket>()
  for (const b of u.byPurpose) {
    const k = purposeKey(b.key)
    const m = merged.get(k) ?? { key: k, cost: 0, calls: 0, inputTokens: 0, outputTokens: 0, unpriced: 0 }
    merged.set(k, {
      ...m,
      cost: m.cost + b.cost,
      calls: m.calls + b.calls,
      inputTokens: m.inputTokens + b.inputTokens,
      outputTokens: m.outputTokens + b.outputTokens,
      unpriced: m.unpriced + b.unpriced
    })
  }
  const purposes = [...merged.values()].sort((a, b) => b.cost - a.cost || b.calls - a.calls)

  return (
    <div data-testid="usage-settings">
      <p className="pt-2 text-sm leading-relaxed text-muted">{t('agent.usage.intro')}</p>
      {u.blocked && (
        <p className="mt-3 flex items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-fg" data-testid="usage-blocked">
          <PauseCircle className="size-4 text-warning" />
          {t('agent.usage.blocked', { kind: t(`agent.usage.${u.blocked}`) })}
        </p>
      )}
      <CurrencySection />
      <Section
        title={t('agent.usage.month')}
        action={
          <Button size="sm" variant="outline" onClick={() => useApp.getState().openUsage()} data-testid="open-usage-dashboard">
            <BarChart3 />
            {t('spend.openDashboard')}
          </Button>
        }
      >
        <div className="flex flex-wrap items-end gap-x-10 gap-y-3">
          <div>
            <p className="font-serif text-3xl font-semibold text-fg tabular-nums" data-testid="usage-month">
              {money.format(u.month)}
            </p>
            <p className="mt-1 text-xs text-muted">{t('agent.usage.calls', { count: u.calls })}</p>
          </div>
          <div>
            <p className="font-serif text-xl text-fg tabular-nums" data-testid="usage-today">
              {money.format(u.today)}
            </p>
            <p className="mt-1 text-xs text-muted">{t('agent.usage.today')}</p>
          </div>
          <div className="min-w-[220px] flex-1">
            <div className="flex h-16 items-end gap-[3px]" aria-label={t('agent.usage.days')}>
              {u.days.map((d) => (
                <Tip key={d.date} label={`${d.date} · ${money.format(d.cost)} · ${t('agent.usage.calls', { count: d.calls })}`} side="top">
                  <div
                    className={cn(
                      'flex-1 rounded-t-sm',
                      d.cost > 0 ? 'bg-accent/70 hover:bg-accent' : d.calls ? 'bg-accent/25' : 'bg-sunken'
                    )}
                    style={{ height: `${d.cost > 0 ? Math.max(8, (d.cost / maxDay) * 100) : d.calls ? 8 : 4}%` }}
                  />
                </Tip>
              ))}
            </div>
            <p className="mt-1 text-right text-xs text-subtle">{t('agent.usage.days')}</p>
          </div>
        </div>
        {u.month > 0 && (
          <p className="mt-3 text-xs text-muted" data-testid="usage-forecast">
            {t('spend.forecast.label')} <span className="font-medium text-fg tabular-nums">{money.format(f.projected)}</span>
            {' · '}
            {f.monthlyLimit === null ? (
              t('spend.forecast.noLimit')
            ) : (
              <span className={f.projected > f.monthlyLimit ? 'text-warning' : ''}>
                {t(f.projected > f.monthlyLimit ? 'spend.forecast.over' : 'spend.forecast.under', { limit: money.format(f.monthlyLimit) })}
              </span>
            )}
          </p>
        )}
        {u.unpriced > 0 && <p className="mt-3 text-xs text-subtle">{t('agent.usage.unpriced', { count: u.unpriced })}</p>}
        {u.calls === 0 ? (
          <p className="mt-4 text-sm text-muted">{t('agent.usage.empty')}</p>
        ) : (
          <div className="mt-5 grid gap-6 sm:grid-cols-2">
            <Buckets title={t('agent.usage.byPurpose')} rows={purposes} label={purpose} money={money} />
            <Buckets title={t('agent.usage.byModel')} rows={u.byModel} label={(k) => k} money={money} />
          </div>
        )}
      </Section>
      <Section title={t('agent.usage.limits')} hint={t('agent.usage.limitsHint')}>
        <div className="grid gap-4 sm:grid-cols-3">
          <LimitInput label={t('agent.usage.perRun')} symbol={money.symbol} value={budget.perRun} onSave={(perRun) => save({ perRun })} />
          <LimitInput label={t('agent.usage.daily')} symbol={money.symbol} value={budget.daily} onSave={(daily) => save({ daily })} />
          <LimitInput
            label={t('agent.usage.monthly')}
            symbol={money.symbol}
            value={budget.monthly}
            onSave={(monthly) => save({ monthly })}
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-fg">{t('spend.alert.title')}</p>
            <p className="mt-0.5 text-xs text-subtle">{t('spend.alert.hint')}</p>
          </div>
          <div className="flex gap-1" role="radiogroup" aria-label={t('spend.alert.title')}>
            {[null, 0.7, 0.8, 0.9].map((v) => (
              <button
                key={String(v)}
                role="radio"
                aria-checked={s.money.alertAt === v}
                onClick={() => update.mutate({ money: { ...s.money, alertAt: v } })}
                className={cn(
                  'h-7 rounded-full border px-3 text-xs transition-colors',
                  s.money.alertAt === v
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-border text-muted hover:bg-surface-hover hover:text-fg'
                )}
              >
                {v === null ? t('spend.alert.off') : t('spend.alert.pct', { pct: Math.round(v * 100) })}
              </button>
            ))}
          </div>
        </div>
        {u.overrideToday && <p className="mt-2 text-xs text-subtle">{t('agent.usage.overridden')}</p>}
      </Section>
      <Section
        title={t('agent.usage.audit')}
        hint={t('agent.usage.auditHint')}
        action={
          <>
            <Button size="sm" variant="ghost" onClick={() => void exportAudit()} disabled={!audit.length}>
              <Download />
              {t('agent.usage.export')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void clearAudit()} disabled={!audit.length}>
              <Trash2 />
              {t('agent.usage.clearAudit')}
            </Button>
          </>
        }
      >
        {callers.length > 1 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {['', ...callers].map((c) => (
              <button
                key={c || 'all'}
                onClick={() => setCaller(c)}
                className={cn(
                  'h-7 rounded-full border px-3 text-xs transition-colors',
                  caller === c
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-border text-muted hover:bg-surface-hover hover:text-fg'
                )}
              >
                {c ? callerLabel(c, t) : t('agent.usage.allCallers')}
              </button>
            ))}
          </div>
        )}
        {audit.length ? (
          <>
            <ul className="divide-y divide-border">
              {audit.map((e) => (
                <AuditRow key={e.id} e={e} />
              ))}
            </ul>
            {!more && audit.length >= 30 && (
              <Button size="sm" variant="ghost" className="mt-1" onClick={() => setMore(true)}>
                {t('agent.usage.showMore')}
              </Button>
            )}
          </>
        ) : (
          <p className="text-sm text-muted">{t('agent.usage.auditEmpty')}</p>
        )}
      </Section>
      <div className="pt-2 pb-4">
        <Button size="sm" variant="secondary" onClick={() => void clearUsage()} disabled={!u.calls}>
          {t('agent.usage.clear')}
        </Button>
      </div>
    </div>
  )
}
