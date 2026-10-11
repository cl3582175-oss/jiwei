import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ArrowRight, Coins, Gauge, Lightbulb, Sprout } from 'lucide-react'
import type { FunnelStage, InsightRange, Insights } from '@shared/insights'
import { api, cn } from '@/lib/utils'
import { useMoney } from '@/lib/money'
import { purposeKey } from '@/features/agent/UsageSettings'
import { Segmented } from '@/features/plan/ui'
import { tintFor } from '@/lib/tint'

// 洞察看板（v0.9）：知识漏斗 + 投入 / 内化 / 产出 / 成本四段。

const KIND_COLOR: Record<string, string> = {
  read: 'var(--p-sky-ink)',
  listen: 'var(--p-lotus-ink)',
  write: 'var(--p-bamboo-ink)',
  review: 'var(--accent)',
  record: 'var(--p-apricot-ink)',
  practice: 'var(--p-sakura-ink)',
  chat: 'var(--p-moon-ink)'
}
const pct = (r: number | null): string => (r === null ? '—' : `${Math.round(r * 100)}%`)
const hours = (m: number): string => (m >= 90 ? String(Math.round((m / 60) * 10) / 10) : '')

export function InsightsView() {
  const { t } = useTranslation()
  const [range, setRange] = useState<'7' | '30' | '90'>('30')
  const { data } = useQuery({
    queryKey: ['learning-insights', range],
    queryFn: () => api.learningInsights.get(Number(range) as InsightRange)
  })
  return (
    <div className="mx-auto max-w-[960px] px-10 pt-8 pb-16" data-testid="insights-view">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="font-serif text-xl font-semibold tracking-wide text-fg">{t('learningInsights.title')}</h1>
          <p className="mt-1.5 max-w-[640px] text-sm leading-relaxed text-muted">{t('learningInsights.desc')}</p>
        </div>
        <Segmented
          label={t('learningInsights.range')}
          value={range}
          onChange={setRange}
          options={(['7', '30', '90'] as const).map((n) => ({ value: n, label: t('learningInsights.days', { n }) }))}
        />
      </div>
      {data && (
        <>
          <Funnel d={data} />
          <div className="mt-5 grid gap-5 md:grid-cols-2">
            <InputCard d={data} />
            <InternalCard d={data} />
            <OutputCard d={data} />
            <CostCard d={data} />
          </div>
        </>
      )}
    </div>
  )
}

function Funnel({ d }: { d: Insights }) {
  const { t } = useTranslation()
  const max = Math.max(1, ...d.funnel.map((s) => s.count))
  const isLeak = (s: FunnelStage): boolean => d.leak?.to === s
  return (
    <section className="paper mt-7 rounded-2xl px-6 py-5 shadow-[var(--shadow-1)]" data-testid="knowledge-funnel">
      <h2 className="text-sm font-semibold text-fg">{t('learningInsights.funnel')}</h2>
      <ol className="mt-4 space-y-2">
        {d.funnel.map((s, i) => {
          const prev = i ? d.funnel[i - 1].count : 0
          const rate = i && prev ? s.count / prev : null
          // 逐级收窄的色条：宽度按数量，最少 6%，保证 0 也看得见位置
          const width = Math.max(6, (s.count / max) * 100)
          return (
            <li
              key={s.stage}
              className="grid grid-cols-[4.5rem_1fr_6rem] items-center gap-3"
              data-stage={s.stage}
              title={t(`learningInsights.stageHints.${s.stage}`)}
            >
              <span className="text-sm text-fg">{t(`learningInsights.stages.${s.stage}`)}</span>
              <div className="relative h-8">
                <div
                  className={cn(
                    'absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center justify-center rounded-md transition-[width] duration-500',
                    isLeak(s.stage) ? 'bg-warning/25' : 'bg-accent-soft'
                  )}
                  style={{ width: `${width}%` }}
                >
                  <span className={cn('font-serif text-base tabular-nums', isLeak(s.stage) ? 'text-warning' : 'text-accent')}>
                    {s.count}
                  </span>
                </div>
              </div>
              <span className={cn('text-right text-2xs tabular-nums', isLeak(s.stage) ? 'font-medium text-warning' : 'text-subtle')}>
                {rate === null ? '' : t('learningInsights.conversion', { rate: pct(Math.min(1, rate)) })}
              </span>
            </li>
          )
        })}
      </ol>
      {d.leak ? (
        <div className="mt-4 flex gap-2.5 rounded-xl bg-warning/[0.07] px-4 py-3 text-sm" data-testid="funnel-leak">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <div>
            <p className="text-fg">
              {t('learningInsights.leak', {
                from: t(`learningInsights.stages.${d.leak.from}`),
                to: t(`learningInsights.stages.${d.leak.to}`),
                rate: pct(d.leak.rate)
              })}
            </p>
            <p className="mt-0.5 text-xs text-muted">{t(`learningInsights.leakTips.${d.leak.to}`)}</p>
          </div>
        </div>
      ) : (
        <p className="mt-4 text-xs text-subtle">{t('learningInsights.empty')}</p>
      )}
    </section>
  )
}

function Card({ icon, title, children, testId }: { icon: ReactNode; title: string; children: ReactNode; testId: string }) {
  return (
    <section className="paper rounded-2xl px-6 py-5 shadow-[var(--shadow-1)]" data-testid={testId}>
      <h2 className="flex items-center gap-2 text-sm font-semibold text-fg [&_svg]:size-4 [&_svg]:text-accent">
        {icon}
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  )
}

function Big({ value, unit, sub }: { value: string; unit?: string; sub?: ReactNode }) {
  return (
    <div>
      <p className="font-serif text-3xl leading-none text-fg tabular-nums">
        {value}
        {unit && <span className="ml-1 font-sans text-sm text-muted">{unit}</span>}
      </p>
      {sub && <p className="mt-1.5 text-xs text-muted">{sub}</p>}
    </div>
  )
}

function InputCard({ d }: { d: Insights }) {
  const { t } = useTranslation()
  const kinds = Object.entries(d.input.byKind).sort((a, b) => b[1] - a[1])
  const total = d.input.totalMinutes
  const maxDay = Math.max(1, ...d.input.daily.map((x) => x.minutes))
  const maxDir = Math.max(1, ...d.input.byDirection.map((x) => x.minutes))
  return (
    <Card icon={<Sprout />} title={t('learningInsights.input')} testId="insights-input">
      <Big
        value={hours(total) || String(total)}
        unit={hours(total) ? t('learningInsights.hours', { h: '' }).trim() : t('learningInsights.minutes', { m: '' }).trim()}
      />
      {total > 0 && (
        <>
          <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-sunken">
            {kinds.map(([k, m]) => (
              <span
                key={k}
                style={{ width: `${(m / total) * 100}%`, background: KIND_COLOR[k] ?? 'var(--subtle)' }}
                title={`${t(`learningInsights.kinds.${k}`)} ${m}′`}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted">
            {kinds.map(([k, m]) => (
              <span key={k} className="inline-flex items-center gap-1">
                <span className="size-2 rounded-full" style={{ background: KIND_COLOR[k] ?? 'var(--subtle)' }} />
                {t(`learningInsights.kinds.${k}`)} {m}′
              </span>
            ))}
          </div>
        </>
      )}
      <div className="mt-4 flex h-12 items-end gap-[2px]" aria-hidden>
        {d.input.daily.map((x) => (
          <span
            key={x.date}
            className="flex-1 rounded-t-sm bg-accent/70"
            style={{ height: `${Math.max(2, (x.minutes / maxDay) * 100)}%`, opacity: x.minutes ? 1 : 0.25 }}
            title={`${x.date} · ${x.minutes}′`}
          />
        ))}
      </div>
      {d.input.byDirection.length > 0 && (
        <div className="mt-4 space-y-1.5">
          <p className="text-2xs text-subtle">{t('learningInsights.directions')}</p>
          {d.input.byDirection.map((g) => (
            <div key={g.goalId} className="flex items-center gap-2 text-xs" data-tint={tintFor(g.goalId, g.color)}>
              <span className="w-24 shrink-0 truncate text-fg">{g.title}</span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
                <span className="block h-full rounded-full bg-[var(--tint-ink)]" style={{ width: `${(g.minutes / maxDir) * 100}%` }} />
              </span>
              <span className="w-12 shrink-0 text-right text-muted tabular-nums">{g.minutes}′</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function InternalCard({ d }: { d: Insights }) {
  const { t } = useTranslation()
  const r = d.internal
  const delta = r.retention !== null && r.retentionPrev !== null ? Math.round((r.retention - r.retentionPrev) * 100) : null
  const causes = Object.entries(r.causes).sort((a, b) => b[1] - a[1])
  return (
    <Card icon={<Gauge />} title={t('learningInsights.internal')} testId="insights-internal">
      <Big
        value={pct(r.retention)}
        sub={
          <>
            {t('learningInsights.retention')} · {t('learningInsights.reviews', { n: r.reviews })}
            {delta !== null && delta !== 0 && (
              <span className={cn('ml-2', delta > 0 ? 'text-accent' : 'text-warning')}>
                {t('learningInsights.vsPrev', { delta: `${delta > 0 ? '+' : ''}${delta}%` })}
              </span>
            )}
          </>
        }
      />
      <div className="mt-4 flex h-10 items-end gap-1" aria-hidden>
        {r.weekly.map((w) => (
          <span
            key={w.week}
            className="flex-1 rounded-t-sm bg-accent/60"
            style={{ height: `${Math.max(4, (w.rate ?? 0) * 100)}%`, opacity: w.rate === null ? 0.2 : 1 }}
            title={`${w.week} · ${pct(w.rate)}`}
          />
        ))}
      </div>
      <p className="mt-3 text-xs text-fg">{t('learningInsights.mastered', { n: r.newlyMastered, total: r.stableTotal })}</p>
      <div className="mt-3">
        <p className="text-2xs text-subtle">{t('learningInsights.causes')}</p>
        {causes.length ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {causes.map(([c, n]) => (
              <span key={c} className="rounded-full bg-sunken px-2.5 py-0.5 text-2xs text-fg">
                {t(`mistakes.causeNames.${c}`)} {n}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted">{t('learningInsights.noMistakes')}</p>
        )}
      </div>
    </Card>
  )
}

function OutputCard({ d }: { d: Insights }) {
  const { t } = useTranslation()
  const o = d.output
  return (
    <Card icon={<Lightbulb />} title={t('learningInsights.output')} testId="insights-output">
      <Big value={pct(o.appliedRate)} sub={`${t('learningInsights.applied')} · ${t('learningInsights.appliedLine', { n: o.applied })}`} />
      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted">{t('learningInsights.works')}</dt>
          <dd className="text-fg tabular-nums">{t('learningInsights.worksLine', { created: o.worksCreated, done: o.worksDone })}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted">{t('learningInsights.decisions')}</dt>
          <dd className="text-right text-fg tabular-nums">
            {t('learningInsights.decisionsLine', { n: o.decisions, reviewed: o.decisionsReviewed })}
            {o.accuracy !== null && (
              <span className="block text-2xs text-muted">{t('learningInsights.accuracy', { a: o.accuracy.toFixed(1) })}</span>
            )}
          </dd>
        </div>
      </dl>
    </Card>
  )
}

function CostCard({ d }: { d: Insights }) {
  const { t } = useTranslation()
  const money = useMoney()
  const groups = new Map<string, number>()
  for (const p of d.cost.byPurpose) groups.set(purposeKey(p.purpose), (groups.get(purposeKey(p.purpose)) ?? 0) + p.usd)
  const list = [...groups.entries()].sort((a, b) => b[1] - a[1])
  const max = Math.max(...list.map((x) => x[1]), 1e-9)
  return (
    <Card icon={<Coins />} title={t('learningInsights.cost')} testId="insights-cost">
      <Big value={money.format(d.cost.usd)} sub={t('learningInsights.costTotal')} />
      <div className="mt-4 space-y-1.5">
        {list.slice(0, 6).map(([k, usd]) => (
          <div key={k} className="flex items-center gap-2 text-xs">
            <span className="w-24 shrink-0 truncate text-fg">{t(`agent.usage.purposes.${k}`, { defaultValue: k })}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
              <span className="block h-full rounded-full bg-accent/70" style={{ width: `${(usd / max) * 100}%` }} />
            </span>
            <span className="w-16 shrink-0 text-right text-muted tabular-nums">{money.format(usd)}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 flex items-center gap-1 text-2xs text-subtle">
        <ArrowRight className="size-3" />
        {t('agent.tabs.usage')}
      </p>
    </Card>
  )
}
