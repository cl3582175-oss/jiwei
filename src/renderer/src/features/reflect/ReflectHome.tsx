import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog as D } from 'radix-ui'
import { toast } from 'sonner'
import { CalendarDays, CalendarRange, Check, ChevronRight, Lightbulb, ListTodo, Plus, Sprout, Target, Trash2, X, Compass, RefreshCcw, History } from 'lucide-react'
import type { ActionItem, Insight, InsightConfidence, Reflection, ReflectionKind } from '@shared/types'
import { api, cn, formatDate, formatRelative } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { confirm, prompt } from '@/components/ui/confirm'
import { useApp } from '@/store/app'

// 复盘首页：今天的 1 分钟微复盘（就地填写）、本周复盘、专题复盘，以及行动项与洞见。

export function useReflectionEvents(): void {
  const qc = useQueryClient()
  useEffect(
    () =>
      window.jiweiEvents.on('reflection:changed', () => {
        for (const k of ['reflection', 'insights', 'actions']) void qc.invalidateQueries({ queryKey: [k] })
      }),
    [qc]
  )
}

const DAY = 86_400_000
const startOfDay = (t = Date.now()): number => new Date(new Date(t).setHours(0, 0, 0, 0)).getTime()

export function dueLabel(dueAt: number | null, t: (k: string, o?: Record<string, unknown>) => string, lang: string): { text: string; late: boolean } | null {
  if (!dueAt) return null
  const today = startOfDay()
  if (dueAt < today) return { text: t('reflect.overdue'), late: true }
  if (dueAt < today + DAY) return { text: t('reflect.dueToday'), late: false }
  if (dueAt < today + 2 * DAY) return { text: t('reflect.dueTomorrow'), late: false }
  return { text: formatDate(dueAt, lang), late: false }
}

export const CONF_TONE: Record<InsightConfidence, string> = {
  hypothesis: 'bg-sunken text-muted',
  believed: 'bg-[#b8862b]/12 text-[#9a6f1f]',
  verified: 'bg-accent-soft text-accent'
}

/* ——— 每日微复盘 ——— */

function DailyCard({ today }: { today: Reflection | null }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const qs = [t('reflect.dq1'), t('reflect.dq2'), t('reflect.dq3')]
  const [answers, setAnswers] = useState(['', '', ''])
  const [editing, setEditing] = useState(false)
  const done = today?.status === 'done'
  useEffect(() => {
    if (!today) return
    void api.reflection.answers(today.id).then((a) => setAnswers([a[0] ?? '', a[1] ?? '', a[2] ?? '']))
  }, [today])
  const save = async (): Promise<void> => {
    if (!answers.some((a) => a.trim())) return
    await api.reflection.saveDaily(answers.map((a) => a.trim()))
    setEditing(false)
    void qc.invalidateQueries({ queryKey: ['reflection'] })
    toast.success(t('reflect.dailySaved'))
  }
  const showForm = !done || editing
  return (
    <section className="paper rounded-2xl px-6 py-5 shadow-[var(--shadow-1)]" data-testid="daily-card">
      <div className="flex items-center gap-2">
        <CalendarDays className="size-4 text-accent" />
        <h2 className="text-sm font-medium text-fg">{t('reflect.dailyTitle')}</h2>
        {done && !editing && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-accent">
            <Check className="size-3.5" />
            {t('reflect.doneToday')}
          </span>
        )}
      </div>
      {showForm ? (
        <div className="mt-4 space-y-3">
          {qs.map((q, i) => (
            <label key={i} className="block">
              <span className="text-xs text-muted">{q}</span>
              <textarea
                value={answers[i]}
                rows={i === 0 ? 2 : 1}
                aria-label={q}
                onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save()
                }}
                className="mt-1 block w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-fg outline-none focus:border-accent"
              />
            </label>
          ))}
          <div className="flex items-center justify-between pt-1">
            <p className="text-2xs text-subtle">{t('reflect.dailyHint')}</p>
            <Button size="sm" variant="primary" disabled={!answers.some((a) => a.trim())} onClick={() => void save()}>
              {t('reflect.dailySave')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {qs.map((q, i) =>
            answers[i] ? (
              <p key={i} className="text-sm leading-relaxed text-fg">
                <span className="mr-2 text-xs text-subtle">{q}</span>
                {answers[i]}
              </p>
            ) : null
          )}
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              {t('memory.edit')}
            </Button>
            {today && (
              <Button size="sm" variant="ghost" onClick={() => useApp.getState().openReflection(today.id)}>
                {t('reflect.openFull')}
                <ChevronRight />
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

/* ——— 行动项 ——— */

function ActionsCard({ list }: { list: ActionItem[] }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['reflection'] })
  const add = async (): Promise<void> => {
    const v = await prompt({ title: t('reflect.addAction'), placeholder: t('reflect.addActionPh'), confirmText: t('common.save') })
    if (!v?.trim()) return
    await api.actions.create(v.trim(), startOfDay() + 8 * DAY - 1)
    refresh()
  }
  return (
    <section className="paper rounded-2xl px-6 py-5 shadow-[var(--shadow-1)]" data-testid="actions-card">
      <div className="flex items-center gap-2">
        <ListTodo className="size-4 text-accent" />
        <h2 className="flex-1 text-sm font-medium text-fg">{t('reflect.actions')}</h2>
        <Tip label={t('reflect.addAction')}>
          <Button size="icon-sm" variant="ghost" aria-label={t('reflect.addAction')} onClick={() => void add()}>
            <Plus />
          </Button>
        </Tip>
      </div>
      {list.length === 0 ? (
        <p className="mt-4 text-xs leading-relaxed text-subtle">{t('reflect.noActions')}</p>
      ) : (
        <ul className="mt-3 space-y-0.5">
          {list.map((a) => (
            <ActionRow key={a.id} a={a} onChange={refresh} lang={i18n.language} />
          ))}
        </ul>
      )}
    </section>
  )
}

export function ActionRow({ a, onChange, lang }: { a: ActionItem; onChange: () => void; lang: string }) {
  const { t } = useTranslation()
  const due = dueLabel(a.dueAt, t, lang)
  const set = (status: ActionItem['status']): void => void api.actions.update(a.id, { status }).then(onChange)
  return (
    <li className="group flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-hover" data-action={a.title}>
      <button
        role="checkbox"
        aria-checked={a.status === 'done'}
        aria-label={a.title}
        onClick={() => set(a.status === 'done' ? 'open' : 'done')}
        className={cn(
          'mt-0.5 grid size-4 shrink-0 place-items-center rounded border transition-colors [&_svg]:size-3',
          a.status === 'done' ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong hover:border-accent'
        )}
      >
        {a.status === 'done' && <Check />}
      </button>
      <span className={cn('min-w-0 flex-1 text-sm leading-snug', a.status !== 'open' ? 'text-subtle line-through' : 'text-fg')}>{a.title}</span>
      {due && a.status === 'open' && <span className={cn('shrink-0 text-2xs', due.late ? 'text-danger' : 'text-subtle')}>{due.text}</span>}
      {a.status === 'open' && (
        <Tip label={t('reflect.drop')}>
          <button
            aria-label={`${t('reflect.drop')}：${a.title}`}
            onClick={() => set('dropped')}
            className="grid size-5 shrink-0 place-items-center rounded text-subtle opacity-0 group-hover:opacity-100 hover:text-danger [&_svg]:size-3.5"
          >
            <X />
          </button>
        </Tip>
      )}
    </li>
  )
}

/* ——— 洞见 ——— */

function InsightDialog({ insight, onClose }: { insight: Insight; onClose: () => void }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const { data: history = [] } = useQuery({ queryKey: ['insights', 'history', insight.id, insight.version], queryFn: () => api.insights.history(insight.id) })
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['insights'] })
  const revise = async (): Promise<void> => {
    const statement = await prompt({ title: t('reflect.reviseTitle'), defaultValue: insight.statement, confirmText: t('common.save') })
    if (!statement?.trim() || statement.trim() === insight.statement) return
    const reason = await prompt({ title: t('reflect.reviseReason'), placeholder: t('reflect.reviseReasonPh'), confirmText: t('common.save') })
    await api.insights.update(insight.id, { statement: statement.trim(), reason: reason?.trim() || undefined })
    refresh()
  }
  const setConf = (confidence: InsightConfidence): void => {
    if (confidence === insight.confidence) return
    void prompt({ title: t('reflect.confReason'), placeholder: t('reflect.reviseReasonPh'), confirmText: t('common.save') }).then((reason) => {
      if (reason === null) return
      void api.insights.update(insight.id, { confidence, reason: reason.trim() || undefined }).then(refresh)
    })
  }
  const refute = async (): Promise<void> => {
    const reason = await prompt({ title: t('reflect.refuteTitle'), placeholder: t('reflect.reviseReasonPh'), confirmText: t('reflect.refute') })
    if (reason === null) return
    await api.insights.update(insight.id, { status: 'refuted', reason: reason.trim() || undefined })
    refresh()
  }
  const remove = async (): Promise<void> => {
    if (!(await confirm({ title: t('reflect.removeInsight'), description: insight.statement, confirmText: t('common.delete'), danger: true }))) return
    await api.insights.remove(insight.id)
    refresh()
    onClose()
  }
  return (
    <D.Root open onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <D.Content className="fixed top-1/2 left-1/2 z-50 max-h-[80vh] w-[min(92vw,560px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-float outline-none">
          <D.Title className={cn('font-serif text-lg leading-relaxed font-semibold', insight.status === 'refuted' ? 'text-muted line-through' : 'text-fg')}>
            {insight.statement}
          </D.Title>
          <D.Description className="sr-only">{t('reflect.history')}</D.Description>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {(['hypothesis', 'believed', 'verified'] as const).map((c) => (
              <button
                key={c}
                onClick={() => setConf(c)}
                className={cn(
                  'rounded-full px-2.5 py-0.5 text-xs transition-colors',
                  insight.confidence === c ? CONF_TONE[c] : 'text-subtle hover:bg-sunken hover:text-muted'
                )}
              >
                {t(`reflect.conf.${c}`)}
              </button>
            ))}
            {insight.status === 'refuted' && <span className="rounded-full bg-danger-soft px-2.5 py-0.5 text-xs text-danger">{t('reflect.refuted')}</span>}
          </div>
          <h3 className="mt-6 flex items-center gap-1.5 text-xs font-medium text-muted">
            <History className="size-3.5" />
            {t('reflect.history')}
          </h3>
          <ol className="relative mt-3 space-y-3 border-l border-border pl-4" data-testid="insight-history">
            {[...history].reverse().map((v) => (
              <li key={v.version} className="relative">
                <span className="absolute top-1.5 -left-[21px] size-2 rounded-full border-2 border-surface bg-accent" />
                <p className="text-2xs text-subtle">
                  v{v.version} · {formatDate(v.createdAt, i18n.language)} · {t(`reflect.conf.${v.confidence}`)}
                </p>
                <p className="mt-0.5 text-sm leading-relaxed text-fg">{v.statement}</p>
                {v.reason && <p className="mt-0.5 text-xs leading-relaxed text-muted">{v.version === 1 ? t('reflect.evidence') : t('reflect.why')}：{v.reason}</p>}
              </li>
            ))}
          </ol>
          <div className="mt-6 flex items-center justify-between">
            <Button size="sm" variant="ghost" className="text-danger hover:bg-danger-soft hover:text-danger" onClick={() => void remove()}>
              <Trash2 />
              {t('common.delete')}
            </Button>
            <div className="flex gap-2">
              {insight.status !== 'refuted' && (
                <Button size="sm" variant="ghost" onClick={() => void refute()}>
                  {t('reflect.refute')}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => void revise()}>
                <RefreshCcw />
                {t('reflect.revise')}
              </Button>
            </div>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

function InsightsCard() {
  const { t, i18n } = useTranslation()
  const { data: list = [] } = useQuery({ queryKey: ['insights'], queryFn: () => api.insights.list() })
  const [open, setOpen] = useState<string | null>(null)
  const current = list.find((i) => i.id === open) ?? null
  return (
    <section className="paper rounded-2xl px-6 py-5 shadow-[var(--shadow-1)]" data-testid="insights-card">
      <div className="flex items-center gap-2">
        <Lightbulb className="size-4 text-accent" />
        <h2 className="text-sm font-medium text-fg">{t('reflect.insights')}</h2>
      </div>
      {list.length === 0 ? (
        <p className="mt-4 text-xs leading-relaxed text-subtle">{t('reflect.noInsights')}</p>
      ) : (
        <ul className="mt-3 space-y-0.5">
          {list.map((x) => (
            <li key={x.id}>
              <button onClick={() => setOpen(x.id)} className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-surface-hover">
                <span className={cn('mt-0.5 shrink-0 rounded-full px-1.5 py-px text-[10px]', CONF_TONE[x.confidence])}>{t(`reflect.conf.${x.confidence}`)}</span>
                <span className={cn('min-w-0 flex-1 text-sm leading-snug', x.status === 'refuted' ? 'text-subtle line-through' : 'text-fg')}>{x.statement}</span>
                <span className="shrink-0 text-2xs text-subtle">
                  {x.version > 1 ? `v${x.version} · ` : ''}
                  {formatRelative(x.updatedAt, i18n.language)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {current && <InsightDialog insight={current} onClose={() => setOpen(null)} />}
    </section>
  )
}

/* ——— 首页 ——— */

const KIND_ICON: Record<ReflectionKind, React.ReactNode> = {
  daily: <CalendarDays />,
  weekly: <CalendarRange />,
  topic: <Compass />,
  practice: <Target />,
  belief: <Sprout />
}

export function ReflectHome() {
  const { t, i18n } = useTranslation()
  const { data: o } = useQuery({ queryKey: ['reflection', 'overview'], queryFn: () => api.reflection.overview() })
  const start = async (kind: ReflectionKind): Promise<void> => {
    let topic: string | undefined
    if (kind !== 'daily' && kind !== 'weekly') {
      const v = await prompt({ title: t(`reflect.startTitle.${kind}`), placeholder: t(`reflect.startPh.${kind}`), confirmText: t('reflect.start') })
      if (!v?.trim()) return
      topic = v.trim()
    }
    const r = await api.reflection.start({ kind, topic })
    useApp.getState().openReflection(r.id)
  }
  if (!o) return null
  const week = o.week
  return (
    <div className="mx-auto max-w-[920px] px-10 pt-8 pb-16">
      <h1 className="font-serif text-xl font-semibold tracking-wide text-fg">{t('reflect.title')}</h1>
      <p className="mt-1.5 text-sm text-muted">{t('reflect.desc')}</p>

      <div className="mt-7 grid grid-cols-[1.618fr_1fr] items-start gap-5">
        <DailyCard today={o.today} />
        <div className="flex flex-col gap-5">
          <section className="paper rounded-2xl px-6 py-5 shadow-[var(--shadow-1)]" data-testid="weekly-card">
            <div className="flex items-center gap-2">
              <CalendarRange className="size-4 text-accent" />
              <h2 className="text-sm font-medium text-fg">{t('reflect.weeklyTitle')}</h2>
            </div>
            <p className="mt-2 text-xs text-muted">
              {formatDate(o.weekStart, i18n.language)} – {formatDate(o.weekEnd - 1, i18n.language)}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-subtle">{t('reflect.weeklyHint')}</p>
            <Button
              className="mt-4 w-full"
              variant={week?.status === 'done' ? 'outline' : 'primary'}
              onClick={() => (week ? useApp.getState().openReflection(week.id) : void start('weekly'))}
            >
              {week?.status === 'done' ? t('reflect.viewWeekly') : week ? t('reflect.continueWeekly') : t('reflect.startWeekly')}
            </Button>
          </section>
          <section className="paper rounded-2xl px-6 py-5 shadow-[var(--shadow-1)]">
            <h2 className="text-sm font-medium text-fg">{t('reflect.special')}</h2>
            <div className="mt-3 grid gap-1.5">
              {(['topic', 'practice', 'belief'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => void start(k)}
                  className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-surface-hover [&_svg]:size-4 [&_svg]:text-accent"
                >
                  {KIND_ICON[k]}
                  <span className="flex-1">
                    <span className="block text-sm text-fg">{t(`reflect.kinds.${k}`)}</span>
                    <span className="block text-2xs text-subtle">{t(`reflect.kindHint.${k}`)}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 items-start gap-5">
        <ActionsCard list={o.openActions} />
        <InsightsCard />
      </div>

      {o.recent.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-medium text-fg">{t('reflect.recent')}</h2>
          <ul className="mt-3 divide-y divide-border/60 rounded-2xl border border-border bg-surface">
            {o.recent.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => useApp.getState().openReflection(r.id)}
                  className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-surface-hover [&_svg]:size-4 [&_svg]:text-subtle"
                >
                  {KIND_ICON[r.kind]}
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">{r.title}</span>
                  <span className={cn('rounded-full px-2 py-0.5 text-2xs', r.status === 'done' ? 'bg-accent-soft text-accent' : 'bg-sunken text-muted')}>
                    {t(`reflect.status.${r.status}`)}
                  </span>
                  <span className="w-24 text-right text-2xs text-subtle">{formatRelative(r.createdAt, i18n.language)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
