import { useEffect, useState } from 'react'
import { FloatingPanel } from '@/components/FloatingPanel'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog as D } from 'radix-ui'
import { toast } from 'sonner'
import { ChevronLeft, Flag, Pencil, Plus, Target, Trash2, Trophy } from 'lucide-react'
import type { Goal } from '@shared/types'
import { api, cn, formatDate, toDateInput } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { confirm, prompt } from '@/components/ui/confirm'
import { useCategories } from '@/lib/queries'
import { MasteryPanel } from './MasteryView'
import { ActionRow } from '../reflect/ReflectHome'
import { errText } from '../chat/useChat'
import { TINTS } from '@/lib/tint'

// 方向：一个目标关联一个分类（含子分类）和若干笔记；进度由其中的复习卡片计算。
// 目标会出现在 AI 的系统提示与每周复盘的素材包中。

function GoalDialog({ goal, onClose }: { goal: Goal | null; onClose: () => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: cats = [], refetch } = useCategories('note')
  // 打开时取最新的分类（可能刚在别处新建）
  useEffect(() => void refetch(), [refetch])
  const [title, setTitle] = useState(goal?.title ?? '')
  const [desc, setDesc] = useState(goal?.description ?? '')
  const [target, setTarget] = useState(goal?.targetAt ? toDateInput(goal.targetAt) : '')
  const [cat, setCat] = useState(goal?.categoryId ?? '')
  const [kind, setKind] = useState<Goal['kind']>(goal?.kind ?? 'skill')
  const [start, setStart] = useState(goal?.startAt ? toDateInput(goal.startAt) : '')
  const [weekly, setWeekly] = useState(goal?.weeklyMinutes ?? 180)
  const [daily, setDaily] = useState<number[] | null>(goal?.weekdayMinutes ?? null)
  const [color, setColor] = useState(goal?.color ?? 'bamboo')
  const save = async (): Promise<void> => {
    if (!title.trim()) return
    try {
      await api.goals.save({
        id: goal?.id,
        title: title.trim(),
        description: desc.trim() || null,
        targetAt: target ? new Date(`${target}T23:59:59`).getTime() : null,
        categoryId: cat || null,
        kind, startAt: start ? new Date(`${start}T00:00:00`).getTime() : null, weeklyMinutes: weekly, weekdayMinutes: daily, color: color as typeof TINTS[number]
      })
      void qc.invalidateQueries({ queryKey: ['goals'] })
      onClose()
    } catch (e) {
      toast.error(errText(e))
    }
  }
  const field = 'mt-1.5 block w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent'
  return (
    <D.Root open onOpenChange={(o) => !o && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px]" />
        <D.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-float outline-none">
          <D.Title className="font-serif text-lg font-semibold text-fg">{goal ? t('goals.edit') : t('goals.new')}</D.Title>
          <D.Description className="mt-1 text-xs text-muted">{t('goals.dialogDesc')}</D.Description>
          <div className="mt-5 space-y-4">
            <label className="block">
              <span className="text-xs text-muted">{t('goals.title')}</span>
              <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('goals.titlePh')} aria-label={t('goals.title')} className={field} />
            </label>
            <label className="block">
              <span className="text-xs text-muted">{t('goals.why')}</span>
              <textarea value={desc} rows={2} onChange={(e) => setDesc(e.target.value)} placeholder={t('goals.whyPh')} aria-label={t('goals.why')} className={cn(field, 'resize-none')} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-muted">{t('goals.target')}</span>
                <input type="date" value={target} onChange={(e) => setTarget(e.target.value)} aria-label={t('goals.target')} className={field} />
              </label>
              <label className="block">
                <span className="text-xs text-muted">{t('goals.category')}</span>
                <select value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t('goals.category')} className={field}>
                  <option value="">{t('goals.noCategory')}</option>
                  {cats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-muted">{t('plan.directionType')}<select aria-label={t('plan.directionType')} className={field} value={kind} onChange={(e) => setKind(e.target.value as Goal['kind'])}>{(['exam', 'skill', 'project', 'interest'] as const).map((k) => <option key={k} value={k}>{t(`plan.directionKinds.${k}`)}</option>)}</select></label>
              <label className="text-xs text-muted">{t('plan.startDate')}<input className={field} type="date" value={start} onChange={(e) => setStart(e.target.value)} /></label>
              <label className="text-xs text-muted">{t('plan.weeklyMinutes')}<input aria-label={t('plan.weeklyMinutes')} className={field} type="number" min="0" max="10080" value={weekly} onChange={(e) => setWeekly(Number(e.target.value))} /></label>
              <label className="text-xs text-muted">{t('plan.color')}<select className={field} value={color} onChange={(e) => setColor(e.target.value)}>{TINTS.map((c) => <option key={c} value={c}>{t(`tints.${c}`, { defaultValue: c })}</option>)}</select></label>
            </div>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={daily !== null} onChange={(e) => setDaily(e.target.checked ? Array.from({ length: 7 }, (_, i) => Math.floor(weekly / 7) + (i < weekly % 7 ? 1 : 0)) : null)} />{t('plan.weekdays')}</label>
            {daily && <div className="grid grid-cols-4 gap-2">{[1, 2, 3, 4, 5, 6, 0].map((d) => <label key={d} className="text-xs text-muted">{t(`plan.days.${d}`)}<input className={field} type="number" min="0" max="1440" value={daily[d]} onChange={(e) => setDaily(daily.map((v, i) => i === d ? Number(e.target.value) : v))} /></label>)}</div>}
            <p className="text-2xs leading-relaxed text-subtle">{t('goals.linkHint')}</p>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" disabled={!title.trim()} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}

function Bar({ value }: { value: number }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
      <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  )
}

function GoalCard({ goal, onOpen }: { goal: Goal; onOpen: () => void }) {
  const { t, i18n } = useTranslation()
  const { data: p } = useQuery({ queryKey: ['goals', goal.id, 'progress'], queryFn: () => api.goals.progress(goal.id) })
  return (
    <button onClick={onOpen} className="paper rounded-2xl px-5 py-4 text-left shadow-[var(--shadow-1)] transition-shadow hover:shadow-[var(--shadow-2)]" data-goal={goal.title}>
      <div className="flex items-center gap-2">
        {goal.status === 'achieved' ? <Trophy className="size-4 text-[#c8963e]" /> : <Target className="size-4 text-accent" />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{goal.title}</span>
        {goal.status !== 'active' && <span className="rounded-full bg-sunken px-2 py-0.5 text-2xs text-muted">{t(`goals.status.${goal.status}`)}</span>}
      </div>
      {p && (
        <>
          <p className="mt-2 text-2xs text-muted">{t(`plan.directionKinds.${goal.kind}`)} · {t('plan.invested', { actual: p.minutesThisWeek, planned: p.plannedMinutesThisWeek })}</p>
          <div className="mt-3 flex items-baseline justify-between text-2xs text-muted">
            <span>{t('goals.mastered', { pct: Math.round(p.mastered * 100) })}</span>
            <span>
              {p.daysLeft !== null
                ? p.daysLeft >= 0
                  ? t('goals.daysLeft', { count: p.daysLeft })
                  : t('goals.overdue')
                : goal.targetAt
                  ? formatDate(goal.targetAt, i18n.language)
                  : ''}
            </span>
          </div>
          <div className="mt-1.5">
            <Bar value={p.mastered} />
          </div>
          <p className="mt-2 text-2xs text-subtle">
            {t('goals.summary', { notes: p.notes, cards: p.cards, reviews: p.reviews7d })}
            {p.weakNotes > 0 && ` · ${t('goals.weakN', { count: p.weakNotes })}`}
          </p>
        </>
      )}
    </button>
  )
}

function GoalDetail({ goal, onBack }: { goal: Goal; onBack: () => void }) {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const { data: p } = useQuery({ queryKey: ['goals', goal.id, 'progress'], queryFn: () => api.goals.progress(goal.id) })
  const { data: acts = [] } = useQuery({ queryKey: ['actions', 'goal', goal.id], queryFn: () => api.actions.list() })
  const mine = acts.filter((a) => a.goalId === goal.id && a.status !== 'dropped')
  const [editing, setEditing] = useState(false)
  const refresh = (): void => {
    for (const k of ['goals', 'actions', 'reflection']) void qc.invalidateQueries({ queryKey: [k] })
  }
  const setStatus = (status: Goal['status']): void => void api.goals.save({ id: goal.id, title: goal.title, status }).then(refresh)
  const remove = async (): Promise<void> => {
    if (!(await confirm({ title: t('goals.removeTitle'), description: goal.title, confirmText: t('common.delete'), danger: true }))) return
    await api.goals.remove(goal.id)
    refresh()
    onBack()
  }
  const addAction = async (): Promise<void> => {
    const v = await prompt({ title: t('reflect.addAction'), placeholder: t('reflect.addActionPh'), confirmText: t('common.save') })
    if (!v?.trim()) return
    await api.actions.create(v.trim(), null, goal.id)
    refresh()
  }
  return (
    <div>
      <button onClick={onBack} className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ChevronLeft className="size-3.5" />
        {t('goals.all')}
      </button>
      <div className="mt-3 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-xl font-semibold text-fg">{goal.title}</h2>
          {goal.description && <p className="mt-1.5 text-sm leading-relaxed text-muted">{goal.description}</p>}
          {goal.targetAt && (
            <p className="mt-1 text-xs text-subtle">
              {t('goals.target')}：{formatDate(goal.targetAt, i18n.language)}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          {goal.status === 'active' ? (
            <Button size="sm" variant="outline" onClick={() => setStatus('achieved')}>
              <Trophy />
              {t('goals.achieve')}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => setStatus('active')}>
              <Flag />
              {t('goals.reopen')}
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" aria-label={t('goals.edit')} onClick={() => setEditing(true)}>
            <Pencil />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={t('common.delete')} onClick={() => void remove()}>
            <Trash2 />
          </Button>
        </div>
      </div>
      {p && (
        <div className="mt-5 grid grid-cols-4 gap-3" data-testid="goal-stats">
          {[
            [t('goals.statMastered'), `${Math.round(p.mastered * 100)}%`],
            [t('goals.statNotes'), p.notes],
            [t('goals.statCards'), `${p.reviewed} / ${p.cards}`],
            [t('goals.statReviews'), p.reviews7d]
          ].map(([k, v]) => (
            <div key={String(k)} className="rounded-xl bg-sunken px-4 py-3">
              <p className="text-2xs text-subtle">{k}</p>
              <p className="mt-0.5 text-md font-medium text-fg tabular-nums">{v}</p>
            </div>
          ))}
        </div>
      )}
      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-fg">{t('reflect.actions')}</h3>
          <Button size="sm" variant="ghost" onClick={() => void addAction()}>
            <Plus />
            {t('reflect.addAction')}
          </Button>
        </div>
        {mine.length ? (
          <ul className="mt-1">
            {mine.map((a) => (
              <ActionRow key={a.id} a={a} lang={i18n.language} onChange={refresh} />
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-subtle">{t('goals.noActions')}</p>
        )}
      </section>
      <section className="mt-6">
        <h3 className="mb-3 text-sm font-medium text-fg">{t('mastery.title')}</h3>
        <MasteryPanel goalId={goal.id} />
      </section>
      {editing && <GoalDialog goal={goal} onClose={() => setEditing(false)} />}
    </div>
  )
}

export function GoalsPanel() {
  const { t } = useTranslation()
  const { data: goals = [] } = useQuery({ queryKey: ['goals'], queryFn: () => api.goals.list() })
  const [open, setOpen] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const current = goals.find((g) => g.id === open)
  if (current) return <GoalDetail goal={current} onBack={() => setOpen(null)} />
  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">{t('goals.desc')}</p>
        <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
          <Plus />
          {t('goals.new')}
        </Button>
      </div>
      {goals.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-border px-4 py-10 text-center text-xs leading-relaxed text-muted">{t('goals.empty')}</p>
      ) : (
        <div className="mt-5 grid grid-cols-2 gap-4">
          {goals.map((g) => (
            <GoalCard key={g.id} goal={g} onOpen={() => setOpen(g.id)} />
          ))}
        </div>
      )}
      {creating && <GoalDialog goal={null} onClose={() => setCreating(false)} />}
    </div>
  )
}

/** 「计划 → 方向」（v0.7.1 起独立成页，不再是复习页的一个标签） */
export function GoalsPage() {
  const { t } = useTranslation()
  return (
    <FloatingPanel flushLeft className="flex flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center border-b border-border/70 pr-[calc(var(--tb-right)+16px)] pl-8">
        <h1 className="font-serif text-md font-semibold tracking-wide text-fg">{t('nav.goals')}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="goals-view">
        <div className="mx-auto max-w-[920px] px-10 pt-8 pb-16">
          <GoalsPanel />
        </div>
      </div>
    </FloatingPanel>
  )
}
