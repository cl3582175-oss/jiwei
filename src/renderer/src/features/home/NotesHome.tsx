import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { PenLine, Flame, NotebookText, CalendarCheck, ArrowUpRight } from 'lucide-react'
import { useHeatmap, useNotes } from '@/lib/queries'
import { useApp } from '@/store/app'
import { useCreateNote } from '@/lib/shortcuts'
import { formatRelative, modKey } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/primitives'
import { Logo } from '@/components/Logo'
import { Heatmap } from './Heatmap'

const HEAT_DAYS = 364

function greetingKey(): 'morning' | 'noon' | 'afternoon' | 'evening' {
  const h = new Date().getHours()
  return h < 11 ? 'morning' : h < 13 ? 'noon' : h < 18 ? 'afternoon' : 'evening'
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3.5 rounded-xl border border-border bg-surface px-5 py-4 shadow-card">
      <div className="grid size-10 place-items-center rounded-lg bg-accent-soft text-accent [&_svg]:size-[18px]">{icon}</div>
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
    <div className="h-full overflow-y-auto">
      <div className="drag h-[52px]" />
      <div className="mx-auto max-w-[960px] px-10 pb-16 animate-[rise-in_360ms_cubic-bezier(0.2,0.9,0.3,1)]">
        {/* 问候 */}
        <div className="flex items-end justify-between gap-6">
          <div>
            <p className="text-sm text-subtle">{today}</p>
            <h1 className="mt-1 font-serif text-2xl leading-tight font-semibold tracking-wide text-fg">{t(`home.greeting.${greetingKey()}`)}</h1>
            <p className="mt-2 text-sm text-muted">{t('app.slogan')}</p>
          </div>
          <Button variant="primary" onClick={() => void createNote()}>
            <PenLine />
            {t('notes.new')}
            <Kbd className="ml-1 border-white/25 bg-white/15 text-current">{modKey}N</Kbd>
          </Button>
        </div>

        {/* 统计 */}
        <div className="mt-10 grid grid-cols-3 gap-4">
          <Stat icon={<NotebookText />} label={t('home.stats.notes')} value={notes.length} />
          <Stat icon={<Flame />} label={t('home.stats.streak')} value={t('home.stats.days', { count: streak })} />
          <Stat icon={<CalendarCheck />} label={t('home.stats.activeDays')} value={t('home.stats.days', { count: active })} />
        </div>

        {/* 热力图 */}
        <section className="mt-6 rounded-xl border border-border bg-surface px-6 py-5 shadow-card">
          <h3 className="mb-4 text-sm font-medium text-fg">{t('home.heatmap')}</h3>
          <Heatmap days={heat} />
        </section>

        {/* 最近编辑 */}
        <section className="mt-10">
          <h3 className="mb-4 text-sm font-medium text-fg">{t('home.recent')}</h3>
          {notes.length === 0 ? (
            <div className="flex flex-col items-center rounded-xl border border-dashed border-border-strong py-14 text-center">
              <Logo size={44} className="opacity-90" />
              <p className="mt-5 text-md font-medium text-fg">{t('notes.empty')}</p>
              <p className="mt-1 text-sm text-muted">{t('notes.emptyHint')}</p>
              <Button className="mt-6" variant="primary" onClick={() => void createNote()}>
                <PenLine />
                {t('home.startWriting')}
              </Button>
            </div>
          ) : (
            // 卡片宽高比取黄金比例
            <div className="grid grid-cols-3 gap-4">
              {notes.slice(0, 6).map((n) => (
                <button
                  key={n.id}
                  onClick={() => openNote(n.id)}
                  className="group flex aspect-[1.618] flex-col rounded-xl border border-border bg-surface p-5 text-left shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-float"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="line-clamp-1 font-serif text-md font-semibold text-fg">{n.title || t('common.untitled')}</span>
                    <ArrowUpRight className="size-4 shrink-0 text-subtle opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  <p className="mt-2 line-clamp-3 flex-1 text-xs leading-[1.7] text-muted">{n.excerpt}</p>
                  <p className="mt-2 text-2xs text-subtle">{formatRelative(n.editedAt, i18n.language)}</p>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
