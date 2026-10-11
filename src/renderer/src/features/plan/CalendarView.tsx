import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { addDays, dayStart, localDay, type PlanEvent } from '@shared/plan'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { FloatingPanel } from '@/components/FloatingPanel'
import { Button } from '@/components/ui/button'
import { tintFor } from '@/lib/tint'
import { errText } from '../chat/useChat'
import { PlanDialog, field } from './ui'
import { IcsDialog } from './IcsDialog'

const HOUR = 32
export const localInput = (t: number): string =>
  `${localDay(t)}T${String(new Date(t).getHours()).padStart(2, '0')}:${String(new Date(t).getMinutes()).padStart(2, '0')}`

function EventDialog({ event, onClose }: { event: Partial<PlanEvent>; onClose: () => void }) {
  const { t } = useTranslation(),
    qc = useQueryClient()
  const { data: goals = [] } = useQuery({ queryKey: ['goals'], queryFn: () => api.goals.list() })
  const [title, setTitle] = useState(event.title ?? '')
  const [kind, setKind] = useState(event.kind ?? 'study')
  const [start, setStart] = useState(localInput(event.startAt ?? Date.now()))
  const [end, setEnd] = useState(localInput(event.endAt ?? Date.now() + 3600000))
  const [allDay, setAllDay] = useState(event.allDay ?? false)
  const [goalId, setGoalId] = useState(event.goalId ?? '')
  const [note, setNote] = useState(event.note ?? '')
  const [saving, setSaving] = useState(false)
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
  return (
    <PlanDialog title={event.id ? event.title! : t('plan.newEvent')} onClose={onClose}>
      {event.readonly ? (
        <>
          <p className="text-sm text-muted">{t('plan.readonly')}</p>
          <p>
            {start} → {end}
          </p>
          {event.link && (
            <Button
              onClick={() => {
                useApp.getState().setView(event.link!.type === 'goal' ? 'goals' : 'reflect')
                onClose()
              }}
            >
              {t('plan.direction')}
            </Button>
          )}
        </>
      ) : (
        <>
          <label className="block text-xs text-muted">
            {t('plan.title')}
            <input autoFocus aria-label={t('plan.title')} className={field} value={title} onChange={(e) => setTitle(e.target.value)} />
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
              <input className={field} type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="text-xs text-muted">
              {t('plan.end')}
              <input className={field} type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
            {t('plan.allDay')}
          </label>
          <label className="block text-xs text-muted">
            {t('plan.note')}
            <textarea className={field} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="flex flex-wrap gap-2">
            {event.id && (
              <>
                <Button disabled={saving} onClick={() => void save('done')}>
                  {t('plan.done')}
                </Button>
                <Button disabled={saving} onClick={() => void save('skipped')}>
                  {t('plan.skip')}
                </Button>
                <Button
                  disabled={saving}
                  onClick={() =>
                    void api.plan
                      .eventRemove(event.id!)
                      .then(onClose)
                      .catch((e) => toast.error(errText(e)))
                  }
                >
                  {t('common.delete')}
                </Button>
              </>
            )}
            <Button
              variant="primary"
              disabled={saving || !title.trim() || new Date(end).getTime() <= new Date(start).getTime()}
              onClick={() => void save()}
            >
              {t('common.save')}
            </Button>
          </div>
        </>
      )}
      <Button variant="ghost" onClick={onClose}>
        {t('common.close')}
      </Button>
    </PlanDialog>
  )
}

function WeekDay({ at, events, onOpen }: { at: number; events: PlanEvent[]; onOpen: (e: Partial<PlanEvent>) => void }) {
  const { t } = useTranslation()
  const drag = useRef<{ y: number; x: number; event?: PlanEvent; edge?: 'start' | 'end'; at: number; moved: boolean } | null>(null)
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null)
  const minute = (e: PointerEvent<HTMLDivElement>): number =>
    Math.max(360, Math.min(1425, 360 + Math.round(((e.clientY - e.currentTarget.getBoundingClientRect().top) / HOUR) * 4) * 15))
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
      className="relative min-w-0 touch-none border-l border-border/50"
      style={{ height: 18 * HOUR, background: 'repeating-linear-gradient(to bottom, transparent 0, transparent 31px, var(--border) 32px)' }}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        drag.current = null
        setSelection(null)
      }}
    >
      {selection && (
        <div
          className="pointer-events-none absolute inset-x-1 rounded bg-accent/20"
          style={{ top: ((selection.from - 360) / 60) * HOUR, height: ((selection.to - selection.from) / 60) * HOUR }}
        />
      )}
      {events
        .filter((v) => !v.allDay)
        .map((v) => {
          const start = Math.max(at + 360 * 60000, v.startAt),
            end = Math.min(addDays(at, 1), v.endAt)
          if (end <= start) return null
          return (
            <button
              key={v.id}
              data-testid="calendar-event"
              data-event-id={v.id}
              data-tint={tintFor(v.goalId ?? v.id, v.color)}
              className={cn(
                'tint absolute inset-x-1 z-10 overflow-hidden rounded border border-accent/40 bg-sunken px-1 py-1 text-left text-[11px] text-fg',
                v.status !== 'planned' && 'opacity-50',
                !v.readonly && 'cursor-grab'
              )}
              style={{ top: ((start - at) / 3600000) * HOUR - 6 * HOUR, height: Math.max(18, ((end - start) / 3600000) * HOUR) }}
            onClick={() => onOpen(v)}
            >
              {!v.readonly && <span data-edge="start" className="absolute inset-x-0 top-0 h-1.5 cursor-ns-resize" />}
              <span className="pointer-events-none block truncate">
                {v.kind !== 'study' && '◇ '}
                {v.title}
              </span>
              <span className="pointer-events-none text-subtle">{t(`plan.status.${v.status}`)}</span>
              {!v.readonly && <span data-edge="end" className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize" />}
            </button>
          )
        })}
    </div>
  )
}

export function CalendarView() {
  const { t, i18n } = useTranslation(),
    qc = useQueryClient()
  const [mode, setMode] = useState<'week' | 'month'>('week'),
    [anchor, setAnchor] = useState(dayStart())
  const [editing, setEditing] = useState<Partial<PlanEvent> | null>(null)
  const [subscriptions, setSubscriptions] = useState(false)
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
  const days = Array.from({ length: mode === 'week' ? 7 : 42 }, (_, i) => addDays(start, i))
  const dayEvents = (at: number): PlanEvent[] => events.filter((v) => v.startAt < addDays(at, 1) && v.endAt > at)
  const load = (at: number) => {
    const f = forecast.find((v) => v.date === localDay(at)),
      n = f ? f.due + f.new : 0
    return (
      <span
        data-forecast-date={localDay(at)}
        data-load={n}
        title={t('plan.forecastHint')}
        className={cn('block text-[10px]', n > (settings?.review.newPerDay ?? 20) * 3 ? 'text-danger' : 'text-muted')}
      >
        {f ? t('plan.load', { count: n }) : '—'}
      </span>
    )
  }
  const date = (at: number): string => new Date(at).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric', weekday: 'short' })
  return (
    <FloatingPanel flushLeft className="flex min-w-0 flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center border-b border-border/70 px-8">
        <h1 className="font-serif text-md font-semibold text-fg">
          <CalendarDays className="mr-2 inline size-4" />
          {t('plan.calendar')}
        </h1>
      </header>
      <div data-testid="calendar-view" className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6 text-fg">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Button onClick={() => setMode('week')} variant={mode === 'week' ? 'primary' : 'ghost'}>
            {t('plan.week')}
          </Button>
          <Button onClick={() => setMode('month')} variant={mode === 'month' ? 'primary' : 'ghost'}>
            {t('plan.month')}
          </Button>
          <Button
            aria-label={t('plan.previous')}
            onClick={() => {
              const d = new Date(anchor)
              if (mode === 'week') d.setDate(d.getDate() - 7)
              else {
                d.setDate(1)
                d.setMonth(d.getMonth() - 1)
              }
              setAnchor(d.getTime())
            }}
          >
            <ChevronLeft />
          </Button>
          <span className="text-sm">{new Date(anchor).toLocaleDateString(i18n.language, { year: 'numeric', month: 'long' })}</span>
          <Button
            aria-label={t('plan.next')}
            onClick={() => {
              const d = new Date(anchor)
              if (mode === 'week') d.setDate(d.getDate() + 7)
              else {
                d.setDate(1)
                d.setMonth(d.getMonth() + 1)
              }
              setAnchor(d.getTime())
            }}
          >
            <ChevronRight />
          </Button>
        <Button onClick={() => setAnchor(dayStart())}>{t('plan.today')}</Button>
        <Button onClick={() => setSubscriptions(true)}>{t('plan.subscribe')}</Button>
          <Button onClick={() => setEditing({})}>
            <Plus />
            {t('plan.newEvent')}
          </Button>
        </div>
        {mode === 'week' ? (
          <div data-testid="calendar-week" className="rounded-xl border border-border">
            <div className="grid grid-cols-[42px_repeat(7,minmax(0,1fr))] border-b border-border">
              <div />
              {days.map((at) => (
                <div key={at} className="min-w-0 border-l border-border p-1 text-center text-xs">
                  <span>{date(at)}</span>
                  {load(at)}
                  {dayEvents(at)
                    .filter((v) => v.allDay)
                    .map((v) => (
                      <button
                        key={v.id}
                        className="mt-1 block w-full truncate rounded bg-sunken p-1 text-left text-[11px]"
                        onClick={() => setEditing(v)}
                      >
                        ◇ {v.title}
                      </button>
                    ))}
                </div>
              ))}
            </div>
            <div className="max-h-[620px] overflow-y-auto">
              <div className="grid grid-cols-[42px_repeat(7,minmax(0,1fr))]">
                <div className="relative">
                  {Array.from({ length: 18 }, (_, i) => (
                    <span key={i} className="absolute text-[10px] text-subtle" style={{ top: i * HOUR }}>
                      {i + 6}:00
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
          <div data-testid="calendar-month" className="grid grid-cols-7 overflow-hidden rounded-xl border border-border">
            {days.map((at) => {
              const es = dayEvents(at)
              return (
                <div key={at} className="min-h-28 min-w-0 border-r border-b border-border/60 p-2">
                  <button
                    className={cn('text-xs', localDay(at) === localDay() && 'font-bold text-accent')}
                    onClick={() => setEditing({ startAt: at + 9 * 3600000, endAt: at + 10 * 3600000 })}
                  >
                    {new Date(at).getDate()}
                  </button>
                  {load(at)}
                  {es.slice(0, 3).map((v) => (
                    <button
                      key={v.id}
                      onClick={() => setEditing(v)}
                      className="mt-1 block w-full truncate rounded bg-sunken px-1 py-0.5 text-left text-[10px]"
                    >
                      {v.kind === 'exam' || v.kind === 'deadline' ? '◇ ' : ''}
                      {v.title}
                    </button>
                  ))}
                  {es.length > 3 && (
                    <button
                      className="mt-1 text-[10px] text-accent"
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
