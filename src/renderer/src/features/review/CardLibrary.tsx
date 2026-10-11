import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, NotebookText, PauseCircle, PlayCircle, Play, Search, X } from 'lucide-react'
import type { CardFilter, CardListItem } from '@shared/types'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'

// 卡片库（v0.7.6）：看得到有哪些卡片，按状态筛选、搜索，勾选后自选复习。

const FILTERS: CardFilter[] = ['due', 'new', 'learning', 'review', 'weak', 'suspended', 'all']
const DAY = 86_400_000

function dueLabel(c: CardListItem, t: (k: string, o?: Record<string, unknown>) => string): { text: string; tone: string } {
  if (c.state === 'new') return { text: t('review.cards.due.new'), tone: 'text-accent' }
  const end = new Date()
  end.setHours(24, 0, 0, 0)
  if (c.due < Date.now() - DAY) return { text: t('review.cards.due.overdue'), tone: 'text-warning' }
  if (c.due <= end.getTime()) return { text: t('review.cards.due.today'), tone: 'text-fg' }
  return { text: t('review.cards.due.inDays', { count: Math.ceil((c.due - end.getTime()) / DAY) }), tone: 'text-subtle' }
}

export function CardLibrary() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [filter, setFilter] = useState<CardFilter>('due')
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const { data: cards = [], isFetched } = useQuery({
    queryKey: ['reviewCards', filter, search],
    queryFn: () => api.review.list(filter, search || undefined)
  })
  const groups = useMemo(() => {
    const m = new Map<string, { noteId: string; title: string; cards: CardListItem[] }>()
    for (const c of cards) {
      const g = m.get(c.noteId) ?? { noteId: c.noteId, title: c.noteTitle, cards: [] }
      g.cards.push(c)
      m.set(c.noteId, g)
    }
    return [...m.values()]
  }, [cards])
  const toggle = (ids: string[], on: boolean): void =>
    setPicked((s) => {
      const n = new Set(s)
      for (const id of ids) {
        if (on) n.add(id)
        else n.delete(id)
      }
      return n
    })
  const chosen = cards.filter((c) => picked.has(c.id))
  const allOn = cards.length > 0 && chosen.length === cards.length
  const suspend = async (on: boolean): Promise<void> => {
    await Promise.all(chosen.map((c) => api.review.suspend(c.id, on)))
    setPicked(new Set())
    void qc.invalidateQueries({ queryKey: ['reviewCards'] })
    void qc.invalidateQueries({ queryKey: ['reviewStats'] })
  }
  return (
    <div className="mx-auto max-w-[860px] px-10 pt-6 pb-16" data-testid="card-library">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('review.tabs.cards')}>
          {FILTERS.map((f) => (
            <button
              key={f}
              role="radio"
              aria-checked={filter === f}
              onClick={() => {
                setFilter(f)
                setPicked(new Set())
              }}
              className={cn(
                'h-7 rounded-full border px-3 text-xs transition-colors',
                filter === f ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:bg-surface-hover hover:text-fg'
              )}
            >
              {t(`review.cards.filter.${f}`)}
            </button>
          ))}
        </div>
        <label className="relative ml-auto">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('review.cards.search')}
            aria-label={t('review.cards.search')}
            className="h-8 w-56 rounded-md border border-border bg-surface pr-7 pl-8 text-sm text-fg outline-none placeholder:text-subtle focus:border-accent"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute top-1/2 right-2 -translate-y-1/2 text-subtle hover:text-fg"
              aria-label={t('common.clear')}
            >
              <X className="size-3.5" />
            </button>
          )}
        </label>
      </div>
      <p className="mt-3 text-2xs text-subtle">{t('review.cards.hint')}</p>

      <div className="sticky top-0 z-10 -mx-2 mt-3 flex items-center gap-3 rounded-xl bg-bg/90 px-2 py-2 backdrop-blur-md">
        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={allOn}
            disabled={!cards.length}
            onChange={(e) =>
              toggle(
                cards.map((c) => c.id),
                e.target.checked
              )
            }
            aria-label={t('review.cards.selectAll')}
            className="accent-[var(--accent)]"
          />
          {chosen.length ? t('review.cards.selected', { count: chosen.length }) : t('review.cards.count', { count: cards.length })}
        </label>
        <div className="ml-auto flex items-center gap-1.5">
          {chosen.length > 0 && filter !== 'suspended' && (
            <Button size="sm" variant="ghost" onClick={() => void suspend(true)}>
              <PauseCircle />
              {t('review.cards.suspend')}
            </Button>
          )}
          {chosen.length > 0 && chosen.some((c) => c.suspended) && (
            <Button size="sm" variant="ghost" onClick={() => void suspend(false)}>
              <PlayCircle />
              {t('review.cards.resume')}
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            disabled={!chosen.filter((c) => !c.suspended).length}
            onClick={() => useApp.getState().startReviewQueue(chosen.filter((c) => !c.suspended).map((c) => c.id))}
            data-testid="cards-start"
          >
            <Play />
            {t('review.cards.start')}
          </Button>
        </div>
      </div>

      {isFetched && !cards.length ? (
        <p className="mt-8 rounded-xl border border-dashed border-border px-4 py-10 text-center text-xs text-muted">
          {t('review.cards.empty')}
        </p>
      ) : (
        <div className="mt-2 space-y-3">
          {groups.map((g) => {
            const ids = g.cards.map((c) => c.id)
            const on = ids.every((id) => picked.has(id))
            const open = !collapsed.has(g.noteId)
            return (
              <section key={g.noteId} className="paper rounded-2xl px-3 py-2 shadow-[var(--shadow-1)]" data-testid="card-group">
                <div className="flex items-center gap-2 px-1 py-1">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => toggle(ids, e.target.checked)}
                    aria-label={t('review.cards.selectNote')}
                    className="accent-[var(--accent)]"
                  />
                  <button
                    onClick={() => setCollapsed((s) => (s.has(g.noteId) ? (s.delete(g.noteId), new Set(s)) : new Set(s).add(g.noteId)))}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium text-fg"
                    aria-expanded={open}
                  >
                    <ChevronRight className={cn('size-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
                    <NotebookText className="size-3.5 shrink-0 text-subtle" />
                    <span className="truncate">{g.title || t('common.untitled')}</span>
                    <span className="shrink-0 text-2xs font-normal text-subtle">{t('review.cards.count', { count: g.cards.length })}</span>
                  </button>
                </div>
                {open && (
                  <ul className="divide-y divide-border/60">
                    {g.cards.map((c) => {
                      const d = dueLabel(c, t)
                      return (
                        <li key={c.id} className="flex items-center gap-2.5 py-2 pr-1 pl-7 text-sm" data-testid="card-row">
                          <input
                            type="checkbox"
                            checked={picked.has(c.id)}
                            onChange={(e) => toggle([c.id], e.target.checked)}
                            aria-label={c.question}
                            className="accent-[var(--accent)]"
                          />
                          <button
                            onClick={() => {
                              const app = useApp.getState()
                              app.openNote(c.noteId)
                              app.setHighlight({ type: 'block', id: c.rowId })
                            }}
                            className={cn(
                              'min-w-0 flex-1 truncate text-left hover:text-accent',
                              c.suspended ? 'text-subtle line-through' : 'text-fg'
                            )}
                          >
                            {c.question}
                          </button>
                          {c.lapses > 0 && (
                            <span className="shrink-0 text-2xs text-warning">{t('review.cards.lapses', { count: c.lapses })}</span>
                          )}
                          <span className="shrink-0 rounded-full bg-sunken px-2 py-0.5 text-2xs text-muted">
                            {t(`review.state.${c.state}`)}
                          </span>
                          <span className={cn('w-16 shrink-0 text-right text-2xs tabular-nums', d.tone)}>{d.text}</span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
