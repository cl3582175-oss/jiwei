import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Streamdown } from 'streamdown'
import { toast } from 'sonner'
import { BrainCircuit, Flame, Layers, NotebookText, PauseCircle, Sparkles, Undo2, Loader2, CheckCircle2, Target, GraduationCap } from 'lucide-react'
import type { AnswerCheck, ReviewCard, ReviewRating } from '@shared/types'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { EmptyState, Kbd } from '@/components/ui/primitives'
import { FloatingPanel } from '@/components/FloatingPanel'
import { InkLeaf } from '@/components/Illustrations'
import { errText } from '../chat/useChat'
import { MasteryPanel } from './MasteryView'
import { GoalsPanel } from './GoalsView'

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

function ReviewToday() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const iv = useInterval()
  const { data: stats } = useReviewStats()
  const [card, setCard] = useState<ReviewCard | null | undefined>(undefined)
  const [revealed, setRevealed] = useState(false)
  const [answer, setAnswer] = useState('')
  const [check, setCheck] = useState<AnswerCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [session, setSession] = useState({ done: 0, again: 0 })
  const seen = useRef<string[]>([])
  const shownAt = useRef(Date.now())
  const last = useRef<string | null>(null)

  const show = useCallback((c: ReviewCard | null) => {
    setCard(c)
    setRevealed(false)
    setAnswer('')
    setCheck(null)
    shownAt.current = Date.now()
  }, [])
  const loadNext = useCallback(async () => show(await api.review.next(seen.current.slice(-1))), [show])

  useEffect(() => {
    void loadNext()
  }, [loadNext])

  const rate = useCallback(
    async (r: ReviewRating) => {
      if (!card || busy) return
      setBusy(true)
      try {
        await api.review.rate(card.id, r, Date.now() - shownAt.current)
        last.current = card.id
        seen.current.push(card.id)
        setSession((s) => ({ done: s.done + 1, again: s.again + (r === 1 ? 1 : 0) }))
        await loadNext()
      } finally {
        setBusy(false)
      }
    },
    [card, busy, loadNext]
  )

  const undo = useCallback(async () => {
    if (!last.current) return
    const c = await api.review.undo(last.current)
    last.current = null
    if (c) {
      setSession((s) => ({ ...s, done: Math.max(0, s.done - 1) }))
      show(c)
      toast(t('review.undone'))
    }
  }, [show, t])

  const runCheck = async (): Promise<void> => {
    if (!card || !answer.trim()) return
    setRevealed(true)
    setChecking(true)
    try {
      setCheck(await api.review.check(card.id, answer.trim()))
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
    await loadNext()
  }

  const now = Date.now()
  return (
    <>
        {stats && (
          <div className="mx-auto flex max-w-[720px] flex-wrap gap-x-8 gap-y-3 px-10 pt-7">
            <Stat icon={<Layers />} label={t('review.statDue')} value={stats.due} />
            <Stat icon={<CheckCircle2 />} label={t('review.statToday')} value={stats.reviewedToday} />
            <Stat icon={<Flame />} label={t('review.statStreak')} value={t('review.days', { count: stats.streak })} />
            <Stat icon={<Target />} label={t('review.statRetention')} value={stats.retention === null ? '—' : `${Math.round(stats.retention * 100)}%`} />
          </div>
        )}

        {card === undefined ? null : card === null ? (
          stats && stats.total === 0 ? (
            <div className="h-[70%]">
              <EmptyState icon={<InkLeaf />} title={t('review.emptyTitle')} hint={t('review.emptyHint')} />
            </div>
          ) : (
            <div className="mx-auto mt-16 max-w-[460px] px-10 text-center" data-testid="review-done">
              <div className="mx-auto grid size-14 place-items-center rounded-full bg-accent-soft text-accent">
                <CheckCircle2 className="size-7" />
              </div>
              <h2 className="mt-5 font-serif text-xl font-semibold text-fg">{t('review.doneTitle')}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                {session.done > 0 ? t('review.doneSession', { count: session.done, again: session.again }) : t('review.nothingDue')}
              </p>
              <p className="mt-1 text-sm text-muted">
                {stats?.laterToday ? t('review.laterToday', { count: stats.laterToday }) : t('review.tomorrow', { count: stats?.tomorrow ?? 0 })}
              </p>
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
              <p className="font-serif text-xl leading-[1.618] font-semibold whitespace-pre-wrap text-fg" data-testid="review-question">
                {card.question}
              </p>

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
                        <Streamdown mode="static" controls={{ code: false, table: false, mermaid: false }}>
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

type Tab = 'today' | 'mastery' | 'goals'

export function ReviewView() {
  const { t } = useTranslation()
  const tab = useApp((s) => s.reviewTab)
  return (
    <FloatingPanel flushLeft className="flex flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-6 border-b border-border/70 pr-[calc(var(--tb-right)+16px)] pl-8">
        <h1 className="font-serif text-md font-semibold tracking-wide text-fg">{t('review.title')}</h1>
        <div role="tablist" className="no-drag inline-flex rounded-lg bg-sunken p-0.5">
          {(['today', 'mastery', 'goals'] as Tab[]).map((k) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => useApp.getState().setReviewTab(k)}
              className={cn('rounded-md px-3 py-1 text-xs transition-colors', tab === k ? 'bg-surface text-fg shadow-card' : 'text-muted hover:text-fg')}
            >
              {t(`review.tabs.${k}`)}
            </button>
          ))}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'today' && <ReviewToday />}
        {tab !== 'today' && (
          <div className="mx-auto max-w-[920px] px-10 pt-8 pb-16">
            {tab === 'mastery' ? (
              <>
                <p className="mb-5 text-sm text-muted">{t('mastery.desc')}</p>
                <MasteryPanel />
              </>
            ) : (
              <GoalsPanel />
            )}
          </div>
        )}
      </div>
    </FloatingPanel>
  )
}