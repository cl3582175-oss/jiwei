import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Streamdown } from 'streamdown'
import { toast } from 'sonner'
import { BrainCircuit, Flame, Layers, NotebookText, PauseCircle, Sparkles, Undo2, Loader2, CheckCircle2, Target, GraduationCap, Flag, ChevronDown, Play, SkipForward } from 'lucide-react'
import { Popover } from 'radix-ui'
import type { AnswerCheck, ReviewCard, ReviewRating } from '@shared/types'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { EmptyState, Kbd, Tip } from '@/components/ui/primitives'
import { FloatingPanel } from '@/components/FloatingPanel'
import { InkLeaf } from '@/components/Illustrations'
import { errText } from '../chat/useChat'
import { MasteryPanel } from './MasteryView'
import { CardLibrary } from './CardLibrary'
import { MistakesView } from '../mistakes/MistakesView'
import { useProvidePageContext } from '../assist/pageContext'
import { RichMistake } from '../mistakes/RichMistake'

// 复习：线索是问题，笔记栏是答案。先想（可以写下来，让 AI 对照笔记检查），再看答案，再评分。
// 评分按钮上显示下次复习的间隔（FSRS）。键盘：空格显示答案，1～4 评分，⌘Z 撤销。

const RATINGS: ReviewRating[] = [1, 2, 3, 4]
const RATING_TONE: Record<ReviewRating, string> = {
  1: 'hover:border-danger/60 hover:bg-danger-soft data-[suggested=true]:border-danger/60 data-[suggested=true]:bg-danger-soft',
  2: 'hover:border-[#b8862b]/60 hover:bg-[#b8862b]/10 data-[suggested=true]:border-[#b8862b]/60 data-[suggested=true]:bg-[#b8862b]/10',
  3: 'hover:border-accent/60 hover:bg-accent-soft data-[suggested=true]:border-accent/60 data-[suggested=true]:bg-accent-soft',
  4: 'hover:border-accent/60 hover:bg-accent-soft data-[suggested=true]:border-accent/60 data-[suggested=true]:bg-accent-soft'
}

export function useReviewStats() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['reviewStats'], queryFn: () => api.review.stats(), refetchInterval: 60_000 })
  useEffect(() => {
    const refresh = (): void => void qc.invalidateQueries({ queryKey: ['reviewStats'] })
    const a = window.jiweiEvents.on('review:changed', refresh)
    return () => a()
  }, [qc])
  return q
}

/** 间隔的口语写法：10 分钟 / 3 小时 / 4 天 / 2 个月 / 1.5 年 */
function useInterval(): (ms: number) => string {
  const { t } = useTranslation()
  return (ms) => {
    const m = Math.max(1, Math.round(ms / 60_000))
    if (m < 60) return t('review.iv.min', { count: m })
    const h = Math.round(m / 60)
    if (h < 24) return t('review.iv.hour', { count: h })
    const d = Math.round(h / 24)
    if (d < 31) return t('review.iv.day', { count: d })
    if (d < 365) return t('review.iv.month', { count: Math.round(d / 30) })
    return t('review.iv.year', { count: Math.round((d / 365) * 10) / 10 })
  }
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-lg bg-sunken text-muted [&_svg]:size-4">{icon}</span>
      <div>
        <p className="text-2xs text-subtle">{label}</p>
        <p className="text-sm font-medium text-fg tabular-nums">{value}</p>
      </div>
    </div>
  )
}

function CheckResult({ r }: { r: AnswerCheck }) {
  const { t } = useTranslation()
  return (
    <div className="mt-5 rounded-xl border border-accent/25 bg-accent-soft/40 px-4 py-3.5 text-sm leading-relaxed" data-testid="answer-check">
      <p className="flex items-start gap-2 text-fg">
        <Sparkles className="mt-1 size-3.5 shrink-0 text-accent" />
        <span>{r.verdict}</span>
      </p>
      {r.missing.length > 0 && (
        <div className="mt-2.5 pl-5.5">
          <p className="text-xs font-medium text-muted">{t('review.missing')}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-fg">
            {r.missing.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      {r.wrong.length > 0 && (
        <div className="mt-2.5 pl-5.5">
          <p className="text-xs font-medium text-danger">{t('review.wrong')}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-fg">
            {r.wrong.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

type TodayCard = Awaited<ReturnType<typeof api.review.today>>[number]

/** 进度与清单：点开可以跳到任意一张（v0.7.7） */
function QueueList({ order, pos, onJump }: { order: string[]; pos: number; onJump: (index: number) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const { data: items = [] } = useQuery({
    queryKey: ['reviewCards', 'queue', order.join(',')],
    queryFn: () => api.review.list('all'),
    enabled: open
  })
  const byId = new Map(items.map((c) => [c.id, c]))
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted tabular-nums hover:bg-surface-hover hover:text-fg" data-testid="queue-progress">
          {t('review.queue.progress', { n: Math.min(pos + 1, order.length), total: order.length })}
          <ChevronDown className="size-3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 max-h-80 w-80 overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-float data-[state=open]:animate-[pop-in_140ms_ease-out]"
          data-testid="queue-list"
        >
          {order.map((id, i) => {
            const c = byId.get(id)
            return (
              <button
                key={`${id}-${i}`}
                disabled={i < pos}
                onClick={() => {
                  setOpen(false)
                  if (i !== pos) onJump(i)
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                  i === pos ? 'bg-accent-soft text-accent' : i < pos ? 'text-subtle line-through' : 'text-fg hover:bg-surface-hover'
                )}
              >
                <span className="w-5 shrink-0 text-right text-2xs text-subtle tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">{c?.question ?? '…'}</span>
              </button>
            )
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** 今日复习的清单（v0.7.7）：先看今天有哪些，默认全选，可以取消或只复习某篇笔记的，再开始 */
function TodayPlan({ stats }: { stats: ReturnType<typeof useReviewStats>['data'] | null }) {
  const { t } = useTranslation()
  const { data: cards } = useQuery({ queryKey: ['reviewCards', 'today'], queryFn: () => api.review.today(), staleTime: 0 })
  const [off, setOff] = useState<Set<string>>(new Set())
  const groups = new Map<string, { title: string; cards: TodayCard[] }>()
  for (const c of cards ?? []) {
    const g = groups.get(c.noteId) ?? { title: c.noteTitle, cards: [] }
    g.cards.push(c)
    groups.set(c.noteId, g)
  }
  const chosen = (cards ?? []).filter((c) => !off.has(c.id))
  const start = (ids: string[]): void => {
    if (ids.length) useApp.getState().startReviewQueue(ids, 'today')
  }
  const toggle = (ids: string[], on: boolean): void =>
    setOff((s) => {
      const n = new Set(s)
      for (const id of ids) {
        if (on) n.delete(id)
        else n.add(id)
      }
      return n
    })
  // 回车 / 空格直接开始（和以前一样一步开始）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement | null)?.closest('textarea, input, button, [contenteditable="true"]')) return
      if ((e.key === 'Enter' || e.key === ' ') && chosen.length) {
        e.preventDefault()
        start(chosen.map((c) => c.id))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  return (
    <div className="mx-auto max-w-[720px] px-10 pt-7 pb-16" data-testid="review-plan">
      {stats && (
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <Stat icon={<Layers />} label={t('review.statDue')} value={stats.due} />
          <Stat icon={<CheckCircle2 />} label={t('review.statToday')} value={stats.reviewedToday} />
          <Stat icon={<Flame />} label={t('review.statStreak')} value={t('review.days', { count: stats.streak })} />
          <Stat icon={<Target />} label={t('review.statRetention')} value={stats.retention === null ? '—' : `${Math.round(stats.retention * 100)}%`} />
        </div>
      )}
      {cards && cards.length === 0 ? (
        stats && stats.total === 0 ? (
          <div className="mt-10">
            <EmptyState icon={<InkLeaf />} title={t('review.emptyTitle')} hint={t('review.emptyHint')} />
          </div>
        ) : (
          <div className="mx-auto mt-16 max-w-[460px] text-center" data-testid="review-done">
            <div className="mx-auto grid size-14 place-items-center rounded-full bg-accent-soft text-accent">
              <CheckCircle2 className="size-7" />
            </div>
            <h2 className="mt-5 font-serif text-xl font-semibold text-fg">{t('review.doneTitle')}</h2>
            <p className="mt-2 text-sm text-muted">
              {stats?.laterToday ? t('review.laterToday', { count: stats.laterToday }) : t('review.tomorrow', { count: stats?.tomorrow ?? 0 })}
            </p>
            <Button className="mt-6" variant="outline" size="sm" onClick={() => useApp.getState().setReviewTab('cards')}>
              {t('review.plan.more')}
            </Button>
          </div>
        )
      ) : (
        cards && (
          <>
            <div className="mt-7 flex items-end justify-between gap-4">
              <div>
                <h2 className="font-serif text-lg font-semibold text-fg">{t('review.plan.title', { count: cards.length })}</h2>
                <p className="mt-1 text-xs text-muted">{t('review.plan.hint')}</p>
              </div>
              <Button variant="primary" className="h-10 px-5" disabled={!chosen.length} onClick={() => start(chosen.map((c) => c.id))} data-testid="plan-start">
                <Play />
                {t('review.plan.start', { count: chosen.length })}
                <Kbd>{t('review.space')}</Kbd>
              </Button>
            </div>
            <div className="mt-4 space-y-3">
              {[...groups.entries()].map(([noteId, g]) => {
                const ids = g.cards.map((c) => c.id)
                const allOn = ids.every((id) => !off.has(id))
                return (
                  <section key={noteId} className="paper rounded-2xl px-3 py-2 shadow-[var(--shadow-1)]" data-testid="plan-group">
                    <div className="flex items-center gap-2 px-1 py-1">
                      <input
                        type="checkbox"
                        checked={allOn}
                        onChange={(e) => toggle(ids, e.target.checked)}
                        aria-label={t('review.cards.selectNote')}
                        className="accent-[var(--accent)]"
                      />
                      <NotebookText className="size-3.5 shrink-0 text-subtle" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{g.title || t('common.untitled')}</span>
                      <button
                        onClick={() => start(ids)}
                        className="shrink-0 rounded-md px-2 py-0.5 text-xs text-accent hover:bg-accent-soft"
                      >
                        {t('review.plan.onlyNote', { count: ids.length })}
                      </button>
                    </div>
                    <ul className="divide-y divide-border/60">
                      {g.cards.map((c) => (
                        <li key={c.id} className="flex items-center gap-2.5 py-2 pr-1 pl-7 text-sm" data-testid="plan-row">
                          <input
                            type="checkbox"
                            checked={!off.has(c.id)}
                            onChange={(e) => toggle([c.id], e.target.checked)}
                            aria-label={c.question}
                            className="accent-[var(--accent)]"
                          />
                          <span className={cn('min-w-0 flex-1 truncate', off.has(c.id) ? 'text-subtle' : 'text-fg')}>{c.question}</span>
                          <span
                            className={cn(
                              'shrink-0 rounded-full px-2 py-0.5 text-2xs',
                              c.bucket === 'new' ? 'bg-accent-soft text-accent' : c.bucket === 'learning' ? 'bg-warning/10 text-warning' : 'bg-sunken text-muted'
                            )}
                          >
                            {t(`review.plan.bucket.${c.bucket}`)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )
              })}
            </div>
          </>
        )
      )}
    </div>
  )
}

function ReviewToday() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const iv = useInterval()
  const { data: stats } = useReviewStats()
  const [card, setCard] = useState<ReviewCard | null | undefined>(undefined)
  const [revealed, setRevealed] = useState(false)
  // 积微助手侧栏的页面上下文：当前这张卡（“不给 AI”的笔记不附带）
  useProvidePageContext(
    card && !card.aiExcluded
      ? { title: t('nav.review'), text: `${t('review.pageCard', { title: card.noteTitle })}\n${card.question}${revealed && card.answer ? `\n---\n${card.answer}` : ''}` }
      : null
  )
  const [answer, setAnswer] = useState('')
  const [check, setCheck] = useState<AnswerCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [session, setSession] = useState({ done: 0, again: 0, practice: 0 })
  // v0.7.7：今日复习先看清单、可以取消勾选，开始后按清单顺序复习（mode = today，全部计入排期）；
  // 从卡片库自选时 mode = custom，没到期的只算练习。复习中可以跳到清单里的任意一张，或跳过当前这张。
  const queue = useApp((s) => s.reviewQueue)
  const mode = useApp((s) => s.reviewQueueMode)
  const [order, setOrder] = useState<string[]>([])
  const [pos, setPos] = useState(0)
  const posRef = useRef(0)
  const orderRef = useRef<string[]>([])
  const [countAll, setCountAll] = useState(false)
  const shownAt = useRef(Date.now())
  const last = useRef<string | null>(null)
  const again = useRef(new Map<string, number>())
  /** 上一次评分“忘了”时追加到末尾的那一项（撤销时一并去掉） */
  const appended = useRef(false)

  const show = useCallback((c: ReviewCard | null) => {
    setCard(c)
    setRevealed(false)
    setAnswer('')
    setCheck(null)
    shownAt.current = Date.now()
  }, [])
  const setQueue = (next: string[], at: number): void => {
    orderRef.current = next
    posRef.current = at
    setOrder(next)
    setPos(at)
  }
  const loadAt = useCallback(
    async (at: number) => {
      let list = orderRef.current
      let i = at
      for (;;) {
        // 跳过已删除的卡片
        while (i < list.length) {
          const c = await api.review.get(list[i])
          if (c) {
            setQueue(list, i)
            return show(c)
          }
          i++
        }
        // 清单做完：今日复习时，选中的卡片里刚学过、20 分钟内又到期的学习中卡片再来一轮
        if (useApp.getState().reviewQueueMode !== 'today') break
        const chosen = new Set(useApp.getState().reviewQueue ?? [])
        const more = (await api.review.today()).filter((c) => c.bucket === 'learning' && chosen.has(c.id)).map((c) => c.id)
        if (!more.length) break
        list = [...list, ...more]
      }
      setQueue(list, list.length)
      show(null)
    },
    [show]
  )

  useEffect(() => {
    setSession({ done: 0, again: 0, practice: 0 })
    again.current.clear()
    last.current = null
    if (!queue) {
      setQueue([], 0)
      setCard(undefined)
      return
    }
    setQueue(queue, 0)
    void loadAt(0)
  }, [queue, loadAt])

  const rate = useCallback(
    async (r: ReviewRating) => {
      if (!card || busy) return
      setBusy(true)
      try {
        const counted = mode === 'today' || countAll || (await api.review.scheduledNow(card.id))
        if (counted) {
          await api.review.rate(card.id, r, Date.now() - shownAt.current, card.variantId)
          last.current = card.id
        } else {
          await api.review.practice(card.id, Date.now() - shownAt.current)
          last.current = null
        }
        // 忘了的卡片放到清单末尾再来一次（同一张最多再来两次）
        let list = orderRef.current
        const n = again.current.get(card.id) ?? 0
        appended.current = r === 1 && n < 2
        if (appended.current) {
          again.current.set(card.id, n + 1)
          list = [...list, card.id]
          orderRef.current = list
        }
        setSession((s) => ({ done: s.done + 1, again: s.again + (r === 1 ? 1 : 0), practice: s.practice + (counted ? 0 : 1) }))
        void qc.invalidateQueries({ queryKey: ['reviewStats'] })
        await loadAt(posRef.current + 1)
      } finally {
        setBusy(false)
      }
    },
    [card, busy, loadAt, mode, countAll, qc]
  )
  /** 跳过当前这张（本轮不再出现，仍留在今天的待复习里） */
  const skip = (): void => {
    const list = orderRef.current.filter((_, i) => i !== posRef.current)
    orderRef.current = list
    void loadAt(posRef.current)
  }
  /** 跳到清单里的某一张：把它挪到当前位置 */
  const jump = (index: number): void => {
    const list = [...orderRef.current]
    const [id] = list.splice(index, 1)
    list.splice(posRef.current, 0, id)
    orderRef.current = list
    void loadAt(posRef.current)
  }
  const exit = (): void => useApp.getState().startReviewQueue(null)

  const undo = useCallback(async () => {
    if (!last.current) return
    const id = last.current
    const c = await api.review.undo(id)
    last.current = null
    if (c) {
      setSession((s) => ({ ...s, done: Math.max(0, s.done - 1) }))
      // 回到刚评分的那一张（评分后位置前进了一格）；“忘了”追加到末尾的那一项一并去掉
      const list = [...orderRef.current]
      if (appended.current && list.at(-1) === id) {
        list.pop()
        again.current.set(id, Math.max(0, (again.current.get(id) ?? 1) - 1))
      }
      appended.current = false
      setQueue(list, Math.max(0, posRef.current - 1))
      show(c)
      toast(t('review.undone'))
    }
  }, [show, t])

  const runCheck = async (): Promise<void> => {
    if (!card || !answer.trim()) return
    setRevealed(true)
    setChecking(true)
    try {
      setCheck(await api.review.check(card.id, answer.trim(), card.variantId))
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setChecking(false)
    }
  }

  // 键盘：空格显示答案；1～4 评分；⌘Z 撤销（输入框中不响应数字与空格）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = (e.target as HTMLElement | null)?.closest('textarea, input, [contenteditable="true"]')
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault()
        void undo()
        return
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || !card) return
      if (e.key === ' ' && !revealed) {
        e.preventDefault()
        setRevealed(true)
      } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault()
        void rate(Number(e.key) as ReviewRating)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, revealed, rate, undo])

  const openInNote = (): void => {
    if (!card) return
    const app = useApp.getState()
    app.openNote(card.noteId)
    app.setHighlight({ type: 'block', id: card.rowId })
  }
  const suspend = async (): Promise<void> => {
    if (!card) return
    await api.review.suspend(card.id, true)
    toast(t('review.suspended'), { action: { label: t('memory.undo'), onClick: () => void api.review.suspend(card.id, false) } })
    void qc.invalidateQueries({ queryKey: ['reviewStats'] })
    skip()
  }
  const flagVariant = async (): Promise<void> => {
    if (!card?.variantId || busy) return
    setBusy(true)
    try { await api.mistakes.flag(card.variantId); show(await api.review.get(card.id)); toast(t('mistakes.flagged')) }
    catch (e) { toast.error(errText(e)) } finally { setBusy(false) }
  }

  const now = Date.now()
  return (
    <>
        {!queue && <TodayPlan stats={stats ?? null} />}
        {queue && card !== null && (
          <div className="mx-auto flex max-w-[720px] flex-wrap items-center gap-x-3 gap-y-2 px-10 pt-6" data-testid="review-queue">
            <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent">
              {mode === 'today' ? t('review.tabs.today') : t('review.queue.title')}
            </span>
            <QueueList order={order} pos={pos} onJump={jump} />
            {card && (
              <Button size="sm" variant="ghost" onClick={skip}>
                <SkipForward />
                {t('review.queue.skip')}
              </Button>
            )}
            {mode === 'custom' && (
              <Tip label={t('review.queue.countHint')}>
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <input type="checkbox" checked={countAll} onChange={(e) => setCountAll(e.target.checked)} className="accent-[var(--accent)]" />
                  {t('review.queue.count')}
                </label>
              </Tip>
            )}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={exit}>
              {mode === 'today' ? t('review.queue.backToPlan') : t('review.queue.exit')}
            </Button>
          </div>
        )}

        {!queue || card === undefined ? null : card === null ? (
          stats && stats.total === 0 ? (
            <div className="h-[70%]">
              <EmptyState icon={<InkLeaf />} title={t('review.emptyTitle')} hint={t('review.emptyHint')} />
            </div>
          ) : (
            <div className="mx-auto mt-16 max-w-[460px] px-10 text-center" data-testid="review-done">
              <div className="mx-auto grid size-14 place-items-center rounded-full bg-accent-soft text-accent">
                <CheckCircle2 className="size-7" />
              </div>
              <h2 className="mt-5 font-serif text-xl font-semibold text-fg">{queue ? t('review.queue.doneTitle') : t('review.doneTitle')}</h2>
              {mode === 'custom' ? (
                <>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{t('review.queue.done', { count: session.done, practice: session.practice })}</p>
                  <Button
                    className="mt-6"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      exit()
                      useApp.getState().setReviewTab('cards')
                    }}
                  >
                    {t('review.queue.back')}
                  </Button>
                </>
              ) : (
                <>
                  <p className="mt-2 text-sm leading-relaxed text-muted">
                    {session.done > 0 ? t('review.doneSession', { count: session.done, again: session.again }) : t('review.nothingDue')}
                  </p>
                  <p className="mt-1 text-sm text-muted">
                    {stats?.laterToday ? t('review.laterToday', { count: stats.laterToday }) : t('review.tomorrow', { count: stats?.tomorrow ?? 0 })}
                  </p>
                  <div className="mt-6 flex justify-center gap-2">
                    <Button variant="outline" size="sm" onClick={exit}>
                      {t('review.queue.backToPlan')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => useApp.getState().setReviewTab('cards')}>
                      {t('review.plan.more')}
                    </Button>
                  </div>
                </>
              )}
              {last.current && (
                <Button className="mt-6" variant="ghost" size="sm" onClick={() => void undo()}>
                  <Undo2 />
                  {t('review.undo')}
                </Button>
              )}
            </div>
          )
        ) : (
          <div className="mx-auto max-w-[720px] px-10 pt-8 pb-16" data-testid="review-card">
            <div className="flex items-center gap-2 text-xs text-muted">
              <button onClick={openInNote} className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-surface-hover hover:text-fg">
                <NotebookText className="size-3.5 shrink-0" />
                <span className="truncate">{card.noteTitle || t('common.untitled')}</span>
              </button>
              <span className={cn('rounded-full px-2 py-0.5 text-2xs', card.state === 'new' ? 'bg-accent-soft text-accent' : 'bg-sunken text-muted')}>
                {t(`review.state.${card.state}`)}
              </span>
            </div>

            <article className="mt-4 rounded-2xl border border-border bg-surface px-8 py-8 shadow-card">
              <div className="font-serif text-xl leading-[1.618] font-semibold text-fg" data-testid="review-question"><RichMistake text={card.question} className="text-xl" /></div>
              {card.kind === 'mistake' && <div className="mt-3 space-y-3">
                <p className="text-xs text-muted">{t(card.variantId ? 'mistakes.generated' : 'mistakes.originalOnly')}</p>
                {card.variantFallback && <p className="rounded-lg bg-sunken p-3 text-xs leading-relaxed text-muted">{t(`mistakes.fallback.${card.variantFallback}`)}</p>}
                {card.variantId && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void flagVariant()}><Flag />{t('mistakes.flag')}</Button>}
                {card.original && <details><summary className="cursor-pointer text-xs text-muted">{t('mistakes.seeOriginal')}</summary><RichMistake className="mt-3 font-normal" text={`${card.original.question}\n\n${card.original.answer}`} /></details>}
              </div>}

              {!revealed && (
                <div className="mt-6">
                  <textarea
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault()
                        if (answer.trim()) void runCheck()
                        else setRevealed(true)
                      }
                    }}
                    rows={3}
                    placeholder={t('review.answerPh')}
                    aria-label={t('review.answerPh')}
                    className="block w-full resize-none rounded-xl border border-border bg-bg px-4 py-3 text-sm leading-relaxed text-fg outline-none placeholder:text-subtle focus:border-accent"
                  />
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <p className="text-2xs text-subtle">{t('review.thinkHint')}</p>
                    <div className="flex gap-2">
                      {answer.trim() && (
                        <Button variant="outline" onClick={() => void runCheck()}>
                          <Sparkles />
                          {t('review.check')}
                        </Button>
                      )}
                      <Button variant="primary" onClick={() => setRevealed(true)}>
                        {t('review.reveal')}
                        <Kbd>{t('review.space')}</Kbd>
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {revealed && (
                <>
                  {answer.trim() && (
                    <div className="mt-6 rounded-xl bg-sunken/70 px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap text-muted">
                      <p className="mb-1 text-2xs text-subtle">{t('review.yourAnswer')}</p>
                      {answer}
                    </div>
                  )}
                  <div className="mt-6 border-t border-dashed border-border pt-6">
                    <div className="chat-md text-[15px]" data-testid="review-answer">
                      {card.answer.trim() ? (
                        card.kind === 'mistake' ? <RichMistake text={card.answer} /> : <Streamdown mode="static" controls={{ code: false, table: false, mermaid: false }}>
                          {card.answer}
                        </Streamdown>
                      ) : (
                        <p className="text-sm text-subtle">{t('review.noAnswer')}</p>
                      )}
                    </div>
                  </div>
                  {checking && (
                    <p className="mt-5 flex items-center gap-2 text-sm text-muted">
                      <Loader2 className="size-4 animate-spin" />
                      {t('review.checking')}
                    </p>
                  )}
                  {check && <CheckResult r={check} />}
                </>
              )}
            </article>

            {revealed && (
              <div className="mt-6 grid grid-cols-4 gap-2.5" role="group" aria-label={t('review.rateLabel')}>
                {RATINGS.map((r) => (
                  <button
                    key={r}
                    disabled={busy}
                    data-suggested={check?.suggested === r}
                    onClick={() => void rate(r)}
                    className={cn(
                      'flex flex-col items-center gap-0.5 rounded-xl border border-border bg-surface px-3 py-3 transition-colors disabled:opacity-60',
                      RATING_TONE[r]
                    )}
                  >
                    <span className="text-sm font-medium text-fg">{t(`review.rating.${r}`)}</span>
                    <span className="text-2xs text-muted tabular-nums">
                      {iv(card.next[r] - now)} · {r}
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="mt-6 flex items-center justify-between text-xs text-subtle">
              <span className="inline-flex items-center gap-1.5">
                <BrainCircuit className="size-3.5" />
                {card.reps > 0 ? t('review.history', { reps: card.reps, lapses: card.lapses }) : t('review.firstTime')}
              </span>
              <div className="flex gap-1">
                {revealed && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => useApp.getState().startFeynman({ concept: card.question, noteId: card.noteId, cardId: card.id })}
                  >
                    <GraduationCap />
                    {t('feynman.fromCard')}
                  </Button>
                )}
                {last.current && (
                  <Button variant="ghost" size="sm" onClick={() => void undo()}>
                    <Undo2 />
                    {t('review.undo')}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => void suspend()}>
                  <PauseCircle />
                  {t('review.suspend')}
                </Button>
              </div>
            </div>
          </div>
        )}
    </>
  )
}

type Tab = 'today' | 'cards' | 'mistakes' | 'mastery'

export function ReviewView() {
  const { t } = useTranslation()
  const tab = useApp((s) => s.reviewTab)
  return (
    <FloatingPanel flushLeft className="flex flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-6 border-b border-border/70 pr-[calc(var(--tb-right)+16px)] pl-8">
        <h1 className="font-serif text-md font-semibold tracking-wide text-fg">{t('review.title')}</h1>
        <div role="tablist" className="no-drag inline-flex rounded-lg bg-sunken p-0.5">
          {(['today', 'cards', 'mistakes', 'mastery'] as Tab[]).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => useApp.getState().setReviewTab(k)}
              className={cn('rounded-md px-3 py-1 text-xs transition-colors', tab === k ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg')}
            >
              {t(k === 'mistakes' ? 'mistakes.title' : `review.tabs.${k}`)}
            </button>
          ))}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'today' && <ReviewToday />}
        {tab === 'cards' && <CardLibrary />}
        {tab === 'mistakes' && <MistakesView />}
        {tab === 'mastery' && (
          <div className="mx-auto max-w-[920px] px-10 pt-8 pb-16">
            <p className="mb-5 text-sm text-muted">{t('mastery.desc')}</p>
            <MasteryPanel />
          </div>
        )}
      </div>
    </FloatingPanel>
  )
}
