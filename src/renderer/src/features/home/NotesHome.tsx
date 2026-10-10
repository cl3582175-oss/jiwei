import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { PenLine, Flame, NotebookText, CalendarCheck, ArrowUpRight, Layers } from 'lucide-react'
import { useHeatmap, useNotes } from '@/lib/queries'
import { useApp } from '@/store/app'
import { useCreateNote } from '@/lib/shortcuts'
import { formatRelative, modKey } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/primitives'
import { Heatmap } from './Heatmap'
import { useReviewStats } from '../review/ReviewView'
import { InkNotes } from '@/components/Illustrations'
import type { Tint } from '@/lib/tint'

const HEAT_DAYS = 364

/** 数值为 0 时显示鼓励文字，而不是冷冰冰的 0 */
function ZeroHint({ text }: { text: string }) {
  return <span className="font-kai text-md font-normal text-muted">{text}</span>
}

function Stat({ icon, label, value, tint }: { icon: React.ReactNode; label: string; value: React.ReactNode; tint: Tint }) {
  return (
    <div className="flex items-center gap-3.5 paper rounded-2xl px-5 py-4 shadow-[var(--shadow-1)]">
      <div data-tint={tint} className="tint grid size-10 place-items-center rounded-xl [&_svg]:size-[18px]">
        {icon}
      </div>
      <div>
        <div className="text-2xs tracking-wide text-subtle">{label}</div>
        <div className="font-serif text-lg leading-tight font-semibold text-fg tabular-nums">{value}</div>
      </div>
    </div>
  )
}

export function NotesHome() {
  const { t, i18n } = useTranslation()
  const openNote = useApp((s) => s.openNote)
  const createNote = useCreateNote()
  const { data: heat = [] } = useHeatmap(HEAT_DAYS)
  const { data: review } = useReviewStats()
  const setView = useApp((s) => s.setView)
  const { data: notes = [] } = useNotes({ sort: 'edited' })

  const { streak, active } = useMemo(() => {
    let s = 0
    // 今天还没学习时，从昨天开始计算连续天数
    for (let i = heat.length - 1; i >= 0; i--) {
      if (heat[i].count > 0) s++
      else if (i === heat.length - 1) continue
      else break
    }
    return { streak: s, active: heat.filter((d) => d.count > 0).length }
  }, [heat])

  const today = new Intl.DateTimeFormat(i18n.language, { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())

  return (
    <div className="@container h-full overflow-y-auto">
      <div className="drag h-[52px]" />
      <div className="mx-auto max-w-[960px] px-6 pb-16 @min-[640px]:px-10 animate-[rise-in_360ms_cubic-bezier(0.2,0.9,0.3,1)]">
        {/* 标题：问候与今天的安排在「今日」，这里只讲笔记 */}
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="font-kai text-md text-subtle">{today}</p>
            <h1 className="mt-1.5 font-display text-[30px] leading-[1.15] font-semibold tracking-[0.06em] text-fg">{t('nav.notes')}</h1>
          </div>
          <Button variant="primary" onClick={() => void createNote()}>
            <PenLine />
            {t('notes.new')}
            <Kbd className="ml-1 border-white/25 bg-white/15 text-current">{modKey}N</Kbd>
          </Button>
        </div>

        {/* 统计 */}
        <div className="mt-10 grid grid-cols-1 gap-4 @min-[560px]:grid-cols-3">
          <Stat
            icon={<NotebookText />}
            label={t('home.stats.notes')}
            value={notes.length || <ZeroHint text={t('empty.statZero')} />}
            tint="bamboo"
          />
          <Stat
            icon={<Flame />}
            label={t('home.stats.streak')}
            value={streak ? t('home.stats.days', { count: streak }) : <ZeroHint text={t('empty.streakZero')} />}
            tint="apricot"
          />
          <Stat icon={<CalendarCheck />} label={t('home.stats.activeDays')} value={t('home.stats.days', { count: active })} tint="sky" />
        </div>

        {/* 今日复习 */}
        {review && review.due > 0 && (
          <button
            onClick={() => setView('review')}
            className="paper group mt-6 flex w-full items-center gap-4 rounded-2xl px-6 py-4 text-left shadow-[var(--shadow-1)] transition-shadow hover:shadow-[var(--shadow-2)]"
            data-testid="home-review"
          >
            <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">
              <Layers className="size-5" />
            </span>
            <span className="flex-1">
              <span className="block text-sm font-medium text-fg">{t('home.reviewDue', { count: review.due })}</span>
              <span className="mt-0.5 block text-xs text-muted">{t('home.reviewHint')}</span>
            </span>
            <span className="text-sm text-accent group-hover:underline">{t('home.reviewStart')}</span>
          </button>
        )}

        {/* 热力图 */}
        <section className="paper mt-6 rounded-2xl px-6 py-5 shadow-[var(--shadow-1)]">
          <h3 className="mb-4 text-sm font-medium text-fg">{t('home.heatmap')}</h3>
          {active === 0 && <p className="-mt-2 mb-4 font-kai text-md text-muted">{t('empty.heatmapFirst')}</p>}
          <Heatmap days={heat} />
        </section>

        {/* 最近编辑 */}
        <section className="mt-10">
          <h3 className="mb-4 text-sm font-medium text-fg">{t('home.recent')}</h3>
          {notes.length === 0 ? (
            <div className="flex flex-col items-center rounded-2xl border border-dashed border-border-strong py-12 text-center">
              <InkNotes size={170} className="text-subtle" />
              <p className="mt-5 font-display text-md font-semibold text-fg">{t('empty.homeTitle')}</p>
              <p className="mt-1.5 text-sm text-muted">{t('empty.homeHint')}</p>
              <Button className="mt-6" variant="primary" onClick={() => void createNote()}>
                <PenLine />
                {t('home.startWriting')}
              </Button>
            </div>
          ) : (
            // 卡片宽高比取黄金比例
            <div className="grid grid-cols-1 gap-4 @min-[420px]:grid-cols-2 @min-[640px]:grid-cols-3">
              {notes.slice(0, 6).map((n) => (
                <button
                  key={n.id}
                  onClick={() => openNote(n.id)}
                  className="paper group flex aspect-[1.618] flex-col rounded-2xl p-5 text-left shadow-[var(--shadow-1)] transition-all duration-300 hover:-translate-y-1 hover:shadow-[var(--shadow-3)]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="line-clamp-1 font-serif text-md font-semibold text-fg">{n.title || t('common.untitled')}</span>
                    <ArrowUpRight className="size-4 shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  <p className="mt-2 line-clamp-3 text-xs leading-[1.7] text-muted">{n.excerpt}</p>
                  <p className="mt-auto pt-2 text-2xs text-subtle">{formatRelative(n.editedAt, i18n.language)}</p>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
