import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CalendarClock, CalendarDays, Check, ChevronLeft, ChevronRight, Flag, Layers, Plus, Rss, SkipForward, Trash2 } from 'lucide-react'
import { addDays, dayStart, localDay, type PlanEvent } from '@shared/plan'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { FloatingPanel } from '@/components/FloatingPanel'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { tintFor } from '@/lib/tint'
import { errText } from '../chat/useChat'
import { PlanDialog, Segmented, field } from './ui'
import { IcsDialog } from './IcsDialog'

// 日历（v0.8）：周视图（6:00–24:00 时间轴，拖选建学习时段、拖动 / 拉伸修改）与月视图。
// 审查后的视觉：事件按方向（或订阅）着色，左侧色条 + 浅底；考试 / 截止带图标；订阅日程虚线边、只读；
// 每天顶部只在有复习负荷时显示“复习 N”；今天的列与日期高亮，周视图有“现在”线。

const HOUR = 40
const FROM = 6
const HOURS = 18
export const localInput = (t: number): string =>
  `${localDay(t)}T${String(new Date(t).getHours()).padStart(2, '0')}:${String(new Date(t).getMinutes()).padStart(2, '0')}`
const hm = (t: number): string => `${String(new Date(t).getHours()).padStart(2, '0')}:${String(new Date(t).getMinutes()).padStart(2, '0')}`
/** 新建日程的默认开始时间：下一个整半点 */
const nextHalfHour = (): number => Math.ceil(Date.now() / 1_800_000) * 1_800_000

function KindIcon({ kind, className }: { kind: PlanEvent['kind']; className?: string }) {
  if (kind === 'exam') return <Flag className={className} />
  if (kind === 'deadline') return <CalendarClock className={className} />
  return null
}

/** 事件块的配色：方向 / 订阅的粉彩；订阅日程虚线边 */
const tintOf = (v: Partial<PlanEvent>): string => tintFor(v.goalId ?? v.feedId ?? v.id ?? 'x', v.color)

function EventDialog({ event, onClose }: { event: Partial<PlanEvent>; onClose: () => void }) {
  const { t, i18n } = useTranslation(),
    qc = useQueryClient()
  const { data: goals = [] } = useQuery({ queryKey: ['goals'], queryFn: () => api.goals.list() })
  const [title, setTitle] = useState(event.title ?? '')
  const [kind, setKind] = useState(event.kind ?? 'study')
  const [start, setStart] = useState(localInput(event.startAt ?? nextHalfHour()))
  const [end, setEnd] = useState(localInput(event.endAt ?? nextHalfHour() + 3_600_000))
  const [allDay, setAllDay] = useState(event.allDay ?? false)
  const [goalId, setGoalId] = useState(event.goalId ?? '')
  const [note, setNote] = useState(event.note ?? '')
  const [saving, setSaving] = useState(false)
  const valid = !!title.trim() && new Date(end).getTime() > new Date(start).getTime()
  const save = async (status = event.status): Promise<void> => {
    setSaving(true)
    try {
      await api.plan.eventSave({
        id: event.id,
        title,
        kind,
        startAt: new Date(start).getTime(),
        endAt: new Date(end).getTime(),
        allDay,
        goalId: goalId || null,
        phaseId: event.phaseId,
        note: note || null,
        status
      })
      void qc.invalidateQueries({ queryKey: ['plan'] })
      onClose()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setSaving(false)
    }
  }
  if (event.readonly) {
    const range = event.allDay
      ? new Date(event.startAt!).toLocaleDateString(i18n.language, { month: 'long', day: 'numeric', weekday: 'short' })
      : `${new Date(event.startAt!).toLocaleString(i18n.language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} – ${hm(event.endAt!)}`
    return (
      <PlanDialog title={event.title ?? ''} description={t('plan.readonly')} size="sm" onClose={onClose}>
        <p className="flex items-center gap-2 text-sm text-fg">
          <CalendarDays className="size-4 text-subtle" />
          {range}
        </p>
        {event.link && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              useApp.getState().setView(event.link!.type === 'goal' ? 'goals' : 'reflect')
              onClose()
            }}
          >
            {t('plan.direction')}
          </Button>
        )}
      </PlanDialog>
    )
  }
  const remove = (): void =>
    void api.plan
      .eventRemove(event.id!)
      .then(() => {
        void qc.invalidateQueries({ queryKey: ['plan'] })
        onClose()
      })
      .catch((e) => toast.error(errText(e)))
  return (
    <PlanDialog
      title={event.id ? event.title! : t('plan.newEvent')}
      size="md"
      onClose={onClose}
      footer={
        <>
          {event.id && (
            <Button variant="ghost" size="sm" className="text-danger hover:bg-danger-soft hover:text-danger" disabled={saving} onClick={remove}>
              <Trash2 />
              {t('common.delete')}
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            {event.id && kind === 'study' && event.status === 'planned' && (
              <>
                <Button variant="ghost" size="sm" disabled={saving} onClick={() => void save('skipped')}>
                  <SkipForward />
                  {t('plan.skip')}
                </Button>
                <Button variant="outline" size="sm" disabled={saving} onClick={() => void save('done')}>
                  <Check />
                  {t('plan.done')}
                </Button>
              </>
            )}
            {event.id && event.status !== 'planned' && (
              <Button variant="ghost" size="sm" disabled={saving} onClick={() => void save('planned')}>
                {t('plan.reopen')}
              </Button>
            )}
            <Button variant="primary" size="sm" disabled={saving || !valid} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </div>
        </>
      }
    >
      <label className="block text-xs text-muted">
        {t('plan.title')}
        <input
          autoFocus
          aria-label={t('plan.title')}
          placeholder={t('plan.titlePh')}
          className={field}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && valid && void save()}
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-muted">
          {t('plan.type')}
          <select className={field} value={kind} onChange={(e) => setKind(e.target.value as PlanEvent['kind'])}>
            {(['study', 'exam', 'deadline', 'event'] as const).map((k) => (
              <option key={k} value={k}>
                {t(`plan.kinds.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted">
          {t('plan.direction')}
          <select className={field} value={goalId} onChange={(e) => setGoalId(e.target.value)}>
            <option value="">{t('plan.noDirection')}</option>
            {goals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted">
          {t('plan.start')}
          <input className={field} type={allDay ? 'date' : 'datetime-local'} value={allDay ? start.slice(0, 10) : start} onChange={(e) => setStart(allDay ? `${e.target.value}T00:00` : e.target.value)} />
        </label>
        <label className="text-xs text-muted">
          {t('plan.end')}
          <input className={field} type={allDay ? 'date' : 'datetime-local'} value={allDay ? end.slice(0, 10) : end} onChange={(e) => setEnd(allDay ? `${e.target.value}T23:59` : e.target.value)} />
        </label>
      </div>
      <label className="flex w-fit items-center gap-2 text-sm text-fg">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="accent-[var(--accent)]" />
        {t('plan.allDay')}
      </label>
      <label className="block text-xs text-muted">
        {t('plan.note')}
        <textarea className={cn(field, 'min-h-16 resize-none')} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
    </PlanDialog>
  )
}

function NowLine({ at }: { at: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  const minutes = (now - at) / 60_000
  if (minutes < FROM * 60 || minutes > (FROM + HOURS) * 60) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 z-20" style={{ top: ((minutes - FROM * 60) / 60) * HOUR }} data-testid="now-line">
      <div className="absolute -top-[3px] -left-[3px] size-[7px] rounded-full bg-danger" />
      <div className="h-px bg-danger/80" />
    </div>
  )
}

function WeekDay({ at, events, onOpen }: { at: number; events: PlanEvent[]; onOpen: (e: Partial<PlanEvent>) => void }) {
  const { t } = useTranslation()
  const drag = useRef<{ y: number; x: number; event?: PlanEvent; edge?: 'start' | 'end'; at: number; moved: boolean } | null>(null)
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null)
  const today = localDay(at) === localDay()
  const minute = (e: PointerEvent<HTMLDivElement>): number =>
    Math.max(FROM * 60, Math.min((FROM + HOURS) * 60 - 15, FROM * 60 + Math.round(((e.clientY - e.currentTarget.getBoundingClientRect().top) / HOUR) * 4) * 15))
  const down = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-event-id]')
    const event = events.find((v) => v.id === target?.dataset.eventId)
    if (event?.readonly) return
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      event,
      edge: (e.target as HTMLElement).dataset.edge as 'start' | 'end' | undefined,
      at: minute(e),
      moved: false
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    d.moved ||= Math.abs(e.clientY - d.y) + Math.abs(e.clientX - d.x) > 4
    if (!d.event) setSelection({ from: Math.min(d.at, minute(e)), to: Math.max(d.at + 30, minute(e)) })
  }
  const up = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    drag.current = null
    setSelection(null)
    if (!d) return
    if (d.event && d.moved) {
      const delta = Math.round(((e.clientY - d.y) / HOUR) * 4) * 15 * 60000
      const columns = d.edge ? 0 : Math.round((e.clientX - d.x) / e.currentTarget.getBoundingClientRect().width)
      const startAt = d.edge === 'end' ? d.event.startAt : addDays(d.event.startAt, columns) + delta
      const endAt = d.edge === 'start' ? d.event.endAt : addDays(d.event.endAt, columns) + delta
      if (endAt > startAt) void api.plan.eventSave({ ...d.event, startAt, endAt }).catch((err) => toast.error(errText(err)))
    } else if (d.event) {
      // 捕获在日期列上的 pointerup 会把原生 click 也发给列，因此普通点击在这里打开详情。
      onOpen(d.event)
    } else {
      const from = Math.min(d.at, minute(e)),
        to = Math.max(from + 30, d.at, minute(e))
      onOpen({ startAt: at + from * 60000, endAt: at + to * 60000, kind: 'study' })
    }
  }
  return (
    <div
      data-testid="calendar-day"
      className={cn('relative min-w-0 touch-none border-l border-border/50', today && 'bg-accent-soft/25')}
      style={{
        height: HOURS * HOUR,
        background: `repeating-linear-gradient(to bottom, transparent 0, transparent ${HOUR - 1}px, color-mix(in oklab, var(--border) 60%, transparent) ${HOUR}px)`
      }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        drag.current = null
        setSelection(null)
      }}
    >
      {today && <NowLine at={at} />}
      {selection && (
        <div
          className="pointer-events-none absolute inset-x-1 z-10 rounded-md border border-accent/50 bg-accent/15"
          style={{ top: ((selection.from - FROM * 60) / 60) * HOUR, height: ((selection.to - selection.from) / 60) * HOUR }}
        >
          <span className="block px-1.5 pt-0.5 text-[10px] text-accent tabular-nums">
            {String(Math.floor(selection.from / 60)).padStart(2, '0')}:{String(selection.from % 60).padStart(2, '0')}
          </span>
        </div>
      )}
      {events
        .filter((v) => !v.allDay)
        .map((v) => {
          const start = Math.max(at + FROM * 3_600_000, v.startAt),
            end = Math.min(addDays(at, 1), v.endAt)
          if (end <= start) return null
          const height = Math.max(20, ((end - start) / 3_600_000) * HOUR - 2)
          const past = v.endAt < Date.now() && v.status === 'planned' && v.kind === 'study'
          return (
            <button
              key={v.id}
              data-testid="calendar-event"
              data-event-id={v.id}
              data-tint={tintOf(v)}
              title={`${v.title} · ${hm(v.startAt)}–${hm(v.endAt)}`}
              className={cn(
                'group absolute inset-x-1 z-10 overflow-hidden rounded-md border-l-[3px] bg-[var(--tint)] px-1.5 text-left text-[11px] leading-tight text-[var(--tint-ink)] shadow-[0_1px_0_rgb(0_0_0/0.04)] transition-[box-shadow,filter] hover:shadow-[var(--shadow-2)]',
                v.readonly ? 'border-dashed border-l-[var(--tint-ink)]/60 border border-[var(--tint-ink)]/25' : 'border-l-[var(--tint-ink)] cursor-grab active:cursor-grabbing',
                v.status === 'done' && 'opacity-60',
                v.status === 'skipped' && 'opacity-45 line-through',
                past && 'opacity-70'
              )}
              style={{ top: ((start - at) / 3_600_000 - FROM) * HOUR + 1, height }}
              onClick={() => onOpen(v)}
            >
              {!v.readonly && <span data-edge="start" className="absolute inset-x-0 top-0 h-1.5 cursor-ns-resize" />}
              <span className={cn('pointer-events-none flex items-center gap-1 font-medium', height < 34 ? 'pt-[3px]' : 'pt-1')}>
                {v.status === 'done' && <Check className="size-3 shrink-0" />}
                <KindIcon kind={v.kind} className="size-3 shrink-0" />
                <span className="truncate">{v.title}</span>
              </span>
              {height >= 34 && (
                <span className="pointer-events-none block truncate text-[10px] opacity-75 tabular-nums">
                  {hm(v.startAt)}–{hm(v.endAt)}
                  {v.status !== 'planned' ? ` · ${t(`plan.status.${v.status}`)}` : ''}
                </span>
              )}
              {!v.readonly && <span data-edge="end" className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize" />}
            </button>
          )
        })}
    </div>
  )
}

/** 全天 / 截止 / 订阅日程的小标签 */
function Chip({ v, onOpen, small }: { v: PlanEvent; onOpen: (v: PlanEvent) => void; small?: boolean }) {
  return (
    <button
      data-tint={tintOf(v)}
      onClick={() => onOpen(v)}
      title={v.title}
      className={cn(
        'mt-1 flex w-full min-w-0 items-center gap-1 rounded-md bg-[var(--tint)] px-1.5 text-left text-[var(--tint-ink)] transition-[filter] hover:brightness-[0.97]',
        small ? 'py-px text-[10px]' : 'py-0.5 text-[11px]',
        v.readonly && 'border border-dashed border-[var(--tint-ink)]/30 bg-transparent',
        v.status === 'done' && 'opacity-60'
      )}
    >
      {v.readonly && v.origin === 'ics' ? <Rss className="size-2.5 shrink-0 opacity-70" /> : <KindIcon kind={v.kind} className="size-3 shrink-0" />}
      <span className="truncate">{v.title}</span>
    </button>
  )
}

export function CalendarView() {
  const { t, i18n } = useTranslation(),
    qc = useQueryClient()
  const [mode, setMode] = useState<'week' | 'month'>('week'),
    [anchor, setAnchor] = useState(dayStart())
  const [editing, setEditing] = useState<Partial<PlanEvent> | null>(null)
  const [subscriptions, setSubscriptions] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const monday = addDays(dayStart(anchor), -(new Date(anchor).getDay() + 6) % 7)
  const first = new Date(anchor)
  first.setDate(1)
  const start = mode === 'week' ? monday : addDays(dayStart(first), -(first.getDay() + 6) % 7),
    end = addDays(start, mode === 'week' ? 7 : 42)
  const { data: events = [] } = useQuery({
    queryKey: ['plan', 'events', start, end],
    queryFn: () => api.plan.events({ startAt: start, endAt: end })
  })
  const { data: forecast = [] } = useQuery({ queryKey: ['plan', 'forecast'], queryFn: () => api.plan.forecast(42) })
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api.settings.get() })
  useEffect(
    () =>
      window.jiweiEvents.on('plan:changed', () => {
        void qc.invalidateQueries({ queryKey: ['plan'] })
        void qc.invalidateQueries({ queryKey: ['goals'] })
      }),
    [qc]
  )
  // 周视图默认滚到 8 点附近（今天时滚到当前时间前一小时）
  useEffect(() => {
    if (mode !== 'week' || !scroller.current) return
    const h = new Date().getHours()
    scroller.current.scrollTop = Math.max(0, (Math.max(8, Math.min(h - 1, 20)) - FROM) * HOUR - 8)
  }, [mode, start])
  const days = Array.from({ length: mode === 'week' ? 7 : 42 }, (_, i) => addDays(start, i))
  const dayEvents = (at: number): PlanEvent[] => events.filter((v) => v.startAt < addDays(at, 1) && v.endAt > at)
  const load = (at: number) => {
    const f = forecast.find((v) => v.date === localDay(at)),
      n = f ? f.due + f.new : 0
    // 没有复习负荷时不占位；过多时醒目
    return (
      <span data-forecast-date={localDay(at)} data-load={n} className={cn(!n && 'invisible')}>
        <Tip label={t('plan.forecastHint')}>
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded-full px-1.5 text-[10px] leading-4 tabular-nums',
              n > (settings?.review.newPerDay ?? 20) * 3 ? 'bg-danger-soft text-danger' : 'bg-sunken text-muted'
            )}
          >
            <Layers className="size-2.5" />
            {t('plan.load', { count: n })}
          </span>
        </Tip>
      </span>
    )
  }
  const shift = (dir: 1 | -1): void => {
    const d = new Date(anchor)
    if (mode === 'week') d.setDate(d.getDate() + 7 * dir)
    else {
      d.setDate(1)
      d.setMonth(d.getMonth() + dir)
    }
    setAnchor(d.getTime())
  }
  const rangeLabel =
    mode === 'week'
      ? `${new Date(start).toLocaleDateString(i18n.language, { month: 'long', day: 'numeric' })} – ${new Date(addDays(start, 6)).toLocaleDateString(
          i18n.language,
          new Date(start).getMonth() === new Date(addDays(start, 6)).getMonth() ? { day: 'numeric' } : { month: 'long', day: 'numeric' }
        )}`
      : new Date(anchor).toLocaleDateString(i18n.language, { year: 'numeric', month: 'long' })
  const weekday = (at: number): string => new Date(at).toLocaleDateString(i18n.language, { weekday: 'short' })
  const isToday = (at: number): boolean => localDay(at) === localDay()
  const thisMonth = new Date(anchor).getMonth()
  return (
    <FloatingPanel flushLeft className="flex min-w-0 flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border/70 pr-[calc(var(--tb-right)+16px)] pl-8">
        <h1 className="flex items-center gap-2 font-serif text-md font-semibold tracking-wide text-fg">
          <CalendarDays className="size-4 text-accent" />
          {t('plan.calendar')}
        </h1>
        <div className="no-drag ml-4 flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label={t('plan.previous')} onClick={() => shift(-1)}>
            <ChevronLeft />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={t('plan.next')} onClick={() => shift(1)}>
            <ChevronRight />
          </Button>
          <span className="ml-1 min-w-0 truncate text-sm font-medium text-fg tabular-nums" data-testid="calendar-range">
            {rangeLabel}
          </span>
          <Button size="sm" variant="ghost" className="ml-1" onClick={() => setAnchor(dayStart())}>
            {t('plan.today')}
          </Button>
        </div>
        <div className="no-drag ml-auto flex items-center gap-2">
          <Segmented
            label={t('plan.calendar')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'week', label: t('plan.week') },
              { value: 'month', label: t('plan.month') }
            ]}
          />
          <Tip label={t('plan.icsHint')}>
            <Button size="sm" variant="ghost" onClick={() => setSubscriptions(true)}>
              <Rss />
              {t('plan.subscribe')}
            </Button>
          </Tip>
          <Button size="sm" variant="primary" onClick={() => setEditing({})}>
            <Plus />
            {t('plan.newEvent')}
          </Button>
        </div>
      </header>
      <div data-testid="calendar-view" className="flex min-h-0 min-w-0 flex-1 flex-col px-6 pt-4 pb-5 text-fg">
        {mode === 'week' ? (
          <div data-testid="calendar-week" className="paper flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl shadow-[var(--shadow-1)]">
            <div className="grid shrink-0 grid-cols-[48px_repeat(7,minmax(0,1fr))] border-b border-border/70">
              <div />
              {days.map((at) => (
                <div key={at} className={cn('min-w-0 border-l border-border/50 px-1.5 pt-2 pb-1.5', isToday(at) && 'bg-accent-soft/25')}>
                  <div className="flex items-center justify-between gap-1">
                    <span className={cn('flex items-baseline gap-1.5 text-xs', isToday(at) ? 'text-accent' : 'text-muted')}>
                      {weekday(at)}
                      <span
                        className={cn(
                          'grid min-w-6 place-items-center rounded-full px-1 font-serif text-base leading-6 tabular-nums',
                          isToday(at) ? 'bg-accent text-accent-fg' : 'text-fg'
                        )}
                      >
                        {new Date(at).getDate()}
                      </span>
                    </span>
                    {load(at)}
                  </div>
                  <div className="min-h-1">
                    {dayEvents(at)
                      .filter((v) => v.allDay)
                      .map((v) => (
                        <Chip key={v.id} v={v} onOpen={setEditing} />
                      ))}
                  </div>
                </div>
              ))}
            </div>
            <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
              <div className="grid grid-cols-[48px_repeat(7,minmax(0,1fr))]">
                <div className="relative">
                  {Array.from({ length: HOURS }, (_, i) => (
                    <span key={i} className="absolute right-2 -translate-y-1/2 text-[10px] text-subtle tabular-nums" style={{ top: i * HOUR }}>
                      {i === 0 ? '' : `${i + FROM}:00`}
                    </span>
                  ))}
                </div>
                {days.map((at) => (
                  <WeekDay key={at} at={at} events={dayEvents(at)} onOpen={setEditing} />
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div data-testid="calendar-month" className="paper grid min-h-0 flex-1 grid-cols-7 grid-rows-[auto_repeat(6,minmax(0,1fr))] overflow-hidden rounded-2xl shadow-[var(--shadow-1)]">
            {days.slice(0, 7).map((at) => (
              <div key={`h${at}`} className="border-b border-border/70 px-2.5 py-1.5 text-xs text-subtle">
                {weekday(at)}
              </div>
            ))}
            {days.map((at, i) => {
              const es = dayEvents(at)
              const other = new Date(at).getMonth() !== thisMonth
              return (
                <div
                  key={at}
                  className={cn(
                    'group min-h-0 min-w-0 overflow-hidden border-border/50 p-1.5',
                    i % 7 !== 6 && 'border-r',
                    i < 35 && 'border-b',
                    isToday(at) && 'bg-accent-soft/25',
                    other && 'bg-sunken/40'
                  )}
                >
                  <div className="flex items-center justify-between gap-1">
                    <button
                      className={cn(
                        'grid size-6 place-items-center rounded-full text-xs tabular-nums transition-colors hover:bg-surface-hover',
                        isToday(at) ? 'bg-accent font-medium text-accent-fg hover:bg-accent' : other ? 'text-subtle' : 'text-fg'
                      )}
                      aria-label={new Date(at).toLocaleDateString(i18n.language)}
                      onClick={() => setEditing({ startAt: at + 9 * 3_600_000, endAt: at + 10 * 3_600_000 })}
                    >
                      {new Date(at).getDate()}
                    </button>
                    {load(at)}
                  </div>
                  {es.slice(0, 3).map((v) => (
                    <Chip key={v.id} v={v} onOpen={setEditing} small />
                  ))}
                  {es.length > 3 && (
                    <button
                      className="mt-0.5 px-1.5 text-[10px] text-accent hover:underline"
                      onClick={() => {
                        setAnchor(at)
                        setMode('week')
                      }}
                    >
                      {t('plan.more', { count: es.length - 3 })}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {editing && <EventDialog key={editing.id ?? 'new'} event={editing} onClose={() => setEditing(null)} />}
        {subscriptions && <IcsDialog onClose={() => setSubscriptions(false)} />}
      </div>
    </FloatingPanel>
  )
}
