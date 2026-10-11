import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowUp,
  Sparkles,
  RotateCw,
  Layers,
  ClipboardCheck,
  Inbox,
  FilePenLine,
  Sprout,
  Check,
  Flame,
  PauseCircle,
  Target,
  NotebookText,
  PenLine,
  FileUp,
  Globe,
  X,
  CircleCheck,
  Reply
} from 'lucide-react'
import type { ActivityKind, TodaySummary } from '@shared/activity'
import { api, cn, formatRelative } from '@/lib/utils'
import { useApp } from '@/store/app'
import { useCreateNote } from '@/lib/shortcuts'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import type { Tint } from '@/lib/tint'
import { useProvidePageContext } from '../assist/pageContext'

// 「今日」（v0.6.7，默认首页）：回答“今天该做什么”。每张卡片都能直接处理，不放只供观看的数字。
// 设计见 docs/design/v0.7-platform-and-loop.md §2.2。

const EVENTS = ['plan:changed', 'review:changed', 'inbox:changed', 'mistakes:changed', 'notes:changed', 'reflection:changed', 'sources:changed'] as const

function greetingKey(): 'morning' | 'noon' | 'afternoon' | 'evening' {
  const h = new Date().getHours()
  return h < 11 ? 'morning' : h < 13 ? 'noon' : h < 18 ? 'afternoon' : 'evening'
}

export function useToday() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ['today'], queryFn: () => api.today.summary(), staleTime: 0, refetchInterval: 60_000 })
  useEffect(() => {
    // 数据变化时晨报也重新取：主进程只在要点变化时才重新生成，其余直接返回当天缓存
    const offs = EVENTS.map((e) =>
      window.jiweiEvents.on(e, () => {
        void qc.invalidateQueries({ queryKey: ['today'] })
        void qc.invalidateQueries({ queryKey: ['today-briefing'] })
      })
    )
    return () => offs.forEach((off) => off())
  }, [qc])
  return query
}

/** 「今天要做」里的一行：图标、标题、说明、一个主操作 */
function Task({
  icon,
  tint,
  title,
  hint,
  time,
  action,
  onAction,
  danger,
  testId,
  extra
}: {
  icon: ReactNode
  tint: Tint
  title: ReactNode
  hint?: ReactNode
  time?: string
  action?: string
  onAction?: () => void
  danger?: boolean
  testId?: string
  extra?: ReactNode
}) {
  return (
    <li className="flex min-w-0 items-center gap-3.5 px-4 py-3.5" data-testid={testId}>
      <span data-tint={tint} className="tint grid size-9 shrink-0 place-items-center rounded-xl [&_svg]:size-[17px]">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm leading-snug text-fg', danger && 'text-danger')}>{title}</p>
        {hint && <p className="mt-0.5 truncate text-xs text-muted">{hint}</p>}
      </div>
      {time && <span className="shrink-0 rounded-md bg-sunken px-1.5 py-0.5 text-xs text-muted tabular-nums">{time}</span>}
      {extra}
      {action && onAction && (
        <Button size="sm" variant="outline" className="shrink-0" onClick={onAction}>
          {action}
        </Button>
      )}
    </li>
  )
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-fg">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

function WeekBars({ week }: { week: TodaySummary['week'] }) {
  const { t, i18n } = useTranslation()
  const max = Math.max(30, ...week.map((d) => d.minutes))
  const fmt = new Intl.DateTimeFormat(i18n.language, { weekday: 'narrow' })
  return (
    <div className="flex h-14 items-end gap-1.5" aria-label={t('today.weekHint')}>
      {week.map((d, i) => (
        <Tip key={d.date} label={`${d.date} · ${t('today.minuteUnit', { count: d.minutes })}`}>
          <div className="flex h-full flex-1 flex-col items-center justify-end gap-1">
            <div
              className={cn('w-full max-w-5 rounded-t-[3px]', i === week.length - 1 ? 'bg-accent' : 'bg-accent/35')}
              style={{ height: `${Math.max(3, (d.minutes / max) * 40)}px` }}
            />
            <span className="text-[11px] leading-none text-subtle">{fmt.format(new Date(`${d.date}T12:00:00`))}</span>
          </div>
        </Tip>
      ))}
    </div>
  )
}

function AskBox({ reply, clearReply }: { reply: string | null; clearReply: () => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (reply) ref.current?.focus()
  }, [reply])
  const send = (): void => {
    if (!text.trim()) return
    useApp.getState().askAssistant(text.trim(), reply ?? undefined)
    setText('')
    clearReply()
  }
  return (
    <div
      className="paper rounded-2xl shadow-[var(--shadow-1)] transition-shadow focus-within:shadow-[var(--shadow-2)]"
      data-testid="today-ask"
    >
      {reply && (
        <div className="flex items-center gap-2 border-b border-border/60 px-4 pt-3 pb-2 text-xs text-muted">
          <Reply className="size-3.5 text-accent" />
          <span className="min-w-0 flex-1 truncate">
            {t('today.replyingTo')}：{reply}
          </span>
          <button aria-label={t('today.cancelReply')} onClick={clearReply} className="rounded p-0.5 hover:bg-surface-hover hover:text-fg">
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2 px-4 py-3">
        <Sparkles className="mb-2 size-[18px] shrink-0 text-accent" />
        <textarea
          ref={ref}
          rows={1}
          value={text}
          aria-label={t('today.ask')}
          placeholder={t('today.ask')}
          onChange={(e) => {
            setText(e.target.value)
            e.target.style.height = '0px'
            e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          className="block max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-relaxed text-fg outline-none placeholder:text-subtle"
        />
        <Button
          size="icon-sm"
          variant="primary"
          className="mb-0.5 rounded-full"
          disabled={!text.trim()}
          aria-label={t('today.askSend')}
          onClick={send}
        >
          <ArrowUp />
        </Button>
      </div>
    </div>
  )
}

function Briefing({ onReply }: { onReply: (text: string) => void }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isFetching } = useQuery({ queryKey: ['today-briefing'], queryFn: () => api.today.briefing(), staleTime: 5 * 60_000 })
  const [refreshing, setRefreshing] = useState(false)
  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      qc.setQueryData(['today-briefing'], await api.today.briefing(true))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setRefreshing(false)
    }
  }
  const loading = !data || refreshing
  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-accent/20 bg-accent-soft/50 px-5 py-4"
      data-testid="today-briefing"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-accent" />
        <h2 className="flex-1 text-xs font-semibold tracking-wide text-accent">{t('today.briefing')}</h2>
        {data && !loading && (
          <>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => onReply(data.text)}>
              <Reply />
              {t('today.reply')}
            </Button>
            <Tip label={t('today.refresh')}>
              <Button size="icon-sm" variant="ghost" aria-label={t('today.refresh')} onClick={() => void refresh()} disabled={isFetching}>
                <RotateCw />
              </Button>
            </Tip>
          </>
        )}
      </div>
      {loading ? (
        <div className="mt-3 space-y-2" aria-busy>
          <p className="text-sm text-muted">{t('today.briefingLoading')}</p>
          <div className="h-3 w-4/5 animate-pulse rounded bg-accent/10" />
        </div>
      ) : (
        <>
          <p className="mt-2.5 font-serif text-[16px] leading-[1.85] text-fg" data-testid="today-briefing-text">
            {data.text}
          </p>
          {!data.ai && <p className="mt-2 text-xs text-muted">{t('today.briefingTemplate')}</p>}
        </>
      )}
    </section>
  )
}

function Fresh() {
  const { t } = useTranslation()
  const createNote = useCreateNote()
  const items = [
    {
      icon: <PenLine />,
      tint: 'bamboo' as Tint,
      title: t('today.fresh.note'),
      hint: t('today.fresh.noteHint'),
      go: () => void createNote()
    },
    {
      icon: <FileUp />,
      tint: 'sky' as Tint,
      title: t('today.fresh.source'),
      hint: t('today.fresh.sourceHint'),
      go: () => void api.sources.importDialog(null).then((r) => r.imported[0] && useApp.getState().openSource(r.imported[0].id))
    },
    {
      icon: <Globe />,
      tint: 'lotus' as Tint,
      title: t('today.fresh.browser'),
      hint: t('today.fresh.browserHint'),
      go: () => useApp.getState().openBrowser()
    }
  ]
  return (
    <section className="paper rounded-2xl px-6 py-6 shadow-[var(--shadow-1)]" data-testid="today-fresh">
      <h2 className="font-serif text-lg font-semibold text-fg">{t('today.fresh.title')}</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">{t('today.fresh.hint')}</p>
      <div className="mt-5 grid grid-cols-1 gap-3 @min-[640px]:grid-cols-3">
        {items.map((i) => (
          <button
            key={i.title}
            onClick={i.go}
            className="group flex items-start gap-3 rounded-xl border border-border bg-surface p-4 text-left transition-colors hover:border-accent/40 hover:bg-accent-soft/40"
          >
            <span data-tint={i.tint} className="tint grid size-9 shrink-0 place-items-center rounded-xl [&_svg]:size-[17px]">
              {i.icon}
            </span>
            <span>
              <span className="block text-sm font-medium text-fg">{i.title}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted">{i.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

/** 给积微助手侧栏的页面上下文：只有这个页面已经显示的数字和标题 */
function pageText(s: TodaySummary, brief: string | undefined, zh: boolean): string {
  const lines = zh
    ? [
        `日期 ${s.date}，连续学习 ${s.streak} 天，今天已学习 ${Object.values(s.minutes).reduce((a, b) => a + b, 0)} 分钟。`,
        `复习到期 ${s.review.due} 张（今天已复习 ${s.review.doneToday}）；错题可练 ${s.mistakes.practiceReady} 道，待核对 ${s.mistakes.unverified} 道；收件箱待整理 ${s.inbox.pending} 条；待确认修改 ${s.proposals.pending} 处。`,
        ...s.actions.map(
          (a) => `行动项：${a.title}${a.dueAt ? `（${new Date(a.dueAt).toLocaleDateString()} 截止${a.overdue ? '，已逾期' : ''}）` : ''}`
        ),
        ...s.goals.map(
          (g) => `目标：${g.title}，掌握 ${Math.round(g.mastered * 100)}%${g.daysLeft !== null ? `，剩 ${g.daysLeft} 天` : ''}`
        ),
        ...(brief ? [`晨报：${brief}`] : [])
      ]
    : [
        `Date ${s.date}, ${s.streak}-day streak, ${Object.values(s.minutes).reduce((a, b) => a + b, 0)} minutes studied today.`,
        `${s.review.due} cards due (${s.review.doneToday} reviewed today); ${s.mistakes.practiceReady} mistakes to practise, ${s.mistakes.unverified} to check; ${s.inbox.pending} inbox items; ${s.proposals.pending} changes to confirm.`,
        ...s.actions.map(
          (a) => `Action: ${a.title}${a.dueAt ? ` (due ${new Date(a.dueAt).toLocaleDateString()}${a.overdue ? ', overdue' : ''})` : ''}`
        ),
        ...s.goals.map(
          (g) => `Goal: ${g.title}, ${Math.round(g.mastered * 100)}% mastered${g.daysLeft !== null ? `, ${g.daysLeft} days left` : ''}`
        ),
        ...(brief ? [`Brief: ${brief}`] : [])
      ]
  return lines.join('\n')
}

/** 费用达到上限时提醒（v0.7）：后台 AI 整理已暂停，可以今天继续或调整上限 */
function BudgetBanner() {
  const { t } = useTranslation()
  const { data: u } = useQuery({ queryKey: ['usage'], queryFn: () => api.usage.summary() })
  if (!u?.blocked) return null
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3"
      data-testid="today-budget"
    >
      <PauseCircle className="size-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-1 text-sm text-fg">
        {t('agent.budget.banner', { kind: t(u.blocked === 'daily' ? 'agent.budget.bannerDaily' : 'agent.budget.bannerMonthly') })}
      </span>
      <Button size="sm" variant="outline" onClick={() => void api.usage.allowToday()}>
        {t('agent.budget.continueToday')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => useApp.getState().openSettings('usage')}>
        {t('agent.budget.adjust')}
      </Button>
    </div>
  )
}

export function TodayView() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const { data: s } = useToday()
  const brief = useQuery({ queryKey: ['today-briefing'], queryFn: () => api.today.briefing(), staleTime: 5 * 60_000, enabled: false })
  const [reply, setReply] = useState<string | null>(null)
  const app = useApp.getState()
  const zh = i18n.language.startsWith('zh')
  useProvidePageContext(
    useMemo(() => (s ? { title: t('today.pageTitle'), text: pageText(s, brief.data?.text, zh) } : null), [s, brief.data?.text, zh, t])
  )

  const today = new Intl.DateTimeFormat(i18n.language, { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())
  const total = s ? Object.values(s.minutes).reduce((a, b) => a + b, 0) : 0
  const done = async (id: string): Promise<void> => {
    try {
      await api.actions.update(id, { status: 'done' })
      void qc.invalidateQueries({ queryKey: ['today'] })
      toast.success(t('today.done'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }
  const tasks: ReactNode[] = []
  if (s) {
    for (const a of s.actions)
      tasks.push(
        <Task
          key={`a:${a.id}`}
          testId="today-action"
          icon={<ClipboardCheck />}
          tint={a.overdue ? 'sakura' : 'gosling'}
          title={a.title}
          hint={a.dueAt ? (a.overdue ? t('today.overdue') : t('today.dueToday')) : t('today.action')}
          danger={a.overdue}
          extra={
            <Tip label={t('today.markDone')}>
              <Button size="icon-sm" variant="ghost" aria-label={t('today.markDone')} onClick={() => void done(a.id)}>
                <CircleCheck />
              </Button>
            </Tip>
          }
        />
      )
    if (s.review.due)
      tasks.push(
        <Task
          key="review"
          testId="today-review"
          icon={<Layers />}
          tint="sky"
          title={t('today.review', { count: s.review.due })}
          hint={s.review.doneToday ? t('today.reviewDone', { count: s.review.doneToday }) : undefined}
          action={t('today.reviewStart')}
          onAction={() => {
            useApp.getState().setReviewTab('today')
            app.setView('review')
          }}
        />
      )
    if (s.mistakes.practiceReady)
      tasks.push(
        <Task
          key="mistakes"
          icon={<FilePenLine />}
          tint="apricot"
          title={t('today.mistakes', { count: s.mistakes.practiceReady })}
          action={t('today.mistakesGo')}
          onAction={() => {
            useApp.getState().setReviewTab('today')
            app.setView('review')
          }}
        />
      )
    if (s.mistakes.unverified)
      tasks.push(
        <Task
          key="unverified"
          icon={<FilePenLine />}
          tint="moon"
          title={t('today.unverified', { count: s.mistakes.unverified })}
          action={t('today.unverifiedGo')}
          onAction={() => {
            useApp.getState().setReviewTab('mistakes')
            app.setView('review')
          }}
        />
      )
    if (s.proposals.pending)
      tasks.push(
        <Task
          key="proposals"
          testId="today-proposals"
          icon={<FilePenLine />}
          tint="lotus"
          title={t('today.proposals', { count: s.proposals.pending })}
          hint={s.proposals.notes[0] ? t('today.proposalsIn', { title: s.proposals.notes[0].title || t('today.untitled') }) : undefined}
          action={t('today.open')}
          onAction={() => s.proposals.notes[0] && app.openNote(s.proposals.notes[0].noteId)}
        />
      )
    if (s.inbox.pending)
      tasks.push(
        <Task
          key="inbox"
          icon={<Inbox />}
          tint="bamboo"
          title={t('today.inbox', { count: s.inbox.pending })}
          hint={s.inboxTriageTime ? t('today.inboxAuto', { time: s.inboxTriageTime }) : undefined}
          action={t('today.inboxGo')}
          onAction={() => app.setView('inbox')}
        />
      )
    if (s.reflection.weeklyDue)
      tasks.push(
        <Task
          key="weekly"
          icon={<Sprout />}
          tint="bamboo"
          title={t('today.weeklyReflection')}
          time={s.reflection.time}
          action={t('today.start')}
          onAction={() => void api.reflection.start({ kind: 'weekly' }).then((r) => app.openReflection(r.id))}
        />
      )
    else if (s.reflection.dailyEnabled && !s.reflection.dailyDone)
      tasks.push(
        <Task
          key="daily"
          icon={<Sprout />}
          tint="bamboo"
          title={t('today.dailyReflection')}
          time={s.reflection.time}
          action={t('today.start')}
          onAction={() => app.openReflection(null)}
        />
      )
  }

  return (
    <div className="@container h-full overflow-y-auto" data-testid="today-view">
      <div className="drag h-[52px]" />
      <div className="mx-auto max-w-[1080px] px-6 pb-16 @min-[720px]:px-10 animate-[rise-in_360ms_cubic-bezier(0.2,0.9,0.3,1)]">
        {/* 问候与连续天数 */}
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div>
            <p className="font-kai text-md text-subtle">{today}</p>
            <h1 className="mt-1.5 font-display text-[32px] leading-[1.15] font-semibold tracking-[0.06em] text-fg @min-[720px]:text-[42px]">
              {t(`home.greeting.${greetingKey()}`)}
            </h1>
          </div>
          {s && (
            <span
              data-tint="apricot"
              className="tint inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium"
              data-testid="today-streak"
            >
              <Flame className="size-4" />
              {s.streak ? t('today.streak', { count: s.streak }) : t('today.streakZero')}
            </span>
          )}
        </div>

        <div className="mt-7 space-y-4">
          <BudgetBanner />
          <AskBox reply={reply} clearReply={() => setReply(null)} />
          <Briefing onReply={setReply} />
        </div>

        {!!s?.schedule.length && <section className="mt-8" data-testid="today-schedule"><h2 className="mb-3 text-sm font-semibold text-fg">{t('plan.schedule')}</h2><ul className="paper divide-y divide-border rounded-2xl px-5">{s.schedule.map((e) => <li key={e.id} className="flex items-center gap-3 py-3 text-sm text-fg"><span className="text-xs text-muted">{e.allDay ? t('plan.allDay') : new Date(e.startAt).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' })}</span><button className="min-w-0 flex-1 truncate text-left" onClick={() => useApp.getState().goNav('calendar')}>{e.title}</button>{e.kind === 'study' && !e.readonly && e.status === 'planned' ? <Button size="sm" onClick={() => void api.plan.eventSave({ ...e, status: 'done' }).catch((err) => toast.error(String(err)))}>{t('plan.done')}</Button> : <span className="text-xs text-subtle">{t(`plan.status.${e.status}`)}</span>}</li>)}</ul></section>}
        {s?.fresh ? (
          <div className="mt-8">
            <Fresh />
          </div>
        ) : (
          s && (
            <div className="mt-9 grid grid-cols-1 gap-8 @min-[880px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <Section title={t('today.todo')}>
                {tasks.length ? (
                  <ul
                    className="paper divide-y divide-border/70 overflow-hidden rounded-2xl shadow-[var(--shadow-1)]"
                    data-testid="today-todo"
                  >
                    {tasks}
                  </ul>
                ) : (
                  <div className="flex items-center gap-3 rounded-2xl border border-dashed border-border-strong px-5 py-6 text-sm text-muted">
                    <Check className="size-5 shrink-0 text-accent" />
                    {t('today.todoEmpty')}
                  </div>
                )}
              </Section>

              <div className="min-w-0 space-y-8">
                <Section title={t('today.minutes')}>
                  <div className="paper rounded-2xl px-5 py-4 shadow-[var(--shadow-1)]" data-testid="today-minutes">
                    <div className="flex items-end justify-between gap-4">
                      <div className="min-w-0">
                        <p className="font-serif text-[26px] leading-tight font-semibold whitespace-nowrap text-fg tabular-nums">
                          {t('today.minutesTotal', { count: total })}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          {total
                            ? (Object.entries(s.minutes) as [ActivityKind, number][])
                                .filter(([, m]) => m > 0)
                                .map(([k, m]) => `${t(`today.kinds.${k}`)} ${m}`)
                                .join(' · ')
                            : t('today.minutesNone')}
                        </p>
                      </div>
                      <div className="w-32 shrink-0">
                        <WeekBars week={s.week} />
                      </div>
                    </div>
                  </div>
                </Section>

                {s.goals.length > 0 && (
                  <Section
                    title={t('today.goals')}
                    aside={
                      <button className="text-xs text-muted hover:text-accent" onClick={() => app.goNav('goals')}>
                        {t('today.goalsManage')}
                      </button>
                    }
                  >
                    <ul className="space-y-2.5">
                      {s.goals.map((g) => (
                        <li key={g.id} className="paper rounded-xl px-4 py-3 shadow-[var(--shadow-1)]">
                          <div className="flex items-center gap-2">
                            <Target className="size-4 shrink-0 text-accent" />
                            <span className="min-w-0 flex-1 truncate text-sm text-fg">{g.title}</span>
                            {g.daysLeft !== null && (
                              <span className={cn('shrink-0 text-xs', g.daysLeft < 0 ? 'text-danger' : 'text-muted')}>
                                {g.daysLeft < 0 ? t('today.goalOverdue') : t('today.goalDays', { count: g.daysLeft })}
                              </span>
                            )}
                          </div>
                          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-sunken">
                            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(g.mastered * 100)}%` }} />
                          </div>
                          <p className="mt-1.5 text-xs text-muted">
                            {g.cards ? t('today.goalMastered', { percent: Math.round(g.mastered * 100) }) : t('today.goalNoCards')}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}

                {s.recentNotes.length > 0 && (
                  <Section title={t('today.recent')}>
                    <ul className="paper divide-y divide-border/70 overflow-hidden rounded-2xl shadow-[var(--shadow-1)]">
                      {s.recentNotes.map((n) => (
                        <li key={n.id}>
                          <button
                            onClick={() => app.openNote(n.id)}
                            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-hover"
                          >
                            <NotebookText className="size-4 shrink-0 text-subtle" />
                            <span className="min-w-0 flex-1 truncate text-sm text-fg">{n.title || t('today.untitled')}</span>
                            <span className="shrink-0 text-xs text-subtle">{formatRelative(n.editedAt, i18n.language)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  )
}
