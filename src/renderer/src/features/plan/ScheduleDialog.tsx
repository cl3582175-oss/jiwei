import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Dialog as D } from 'radix-ui'
import { toast } from 'sonner'
import type { Goal } from '@shared/types'
import { addDays, dayStart, localDay, type ScheduleInput, type SchedulePreview } from '@shared/plan'
import { api, toDateInput } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useSettings, useUpdateSettings } from '@/lib/queries'

export function ScheduleDialog({ goal, onClose }: { goal: Goal; onClose: () => void }) {
  const { t, i18n } = useTranslation(),
    { data: settings } = useSettings(),
    update = useUpdateSettings()
  const [start, setStart] = useState(toDateInput(Math.max(goal.startAt ?? Date.now(), Date.now())))
  const [target, setTarget] = useState(toDateInput(goal.targetAt ?? addDays(dayStart(), 30)))
  const weekly = goal.weeklyMinutes ?? 180
  const [daily, setDaily] = useState(
    goal.weekdayMinutes ?? Array.from({ length: 7 }, (_, i) => Math.floor(weekly / 7) + (i < weekly % 7 ? 1 : 0))
  )
  const [avoid, setAvoid] = useState(true),
    [preference, setPreference] = useState<ScheduleInput['preference']>('evening'),
    [minutes, setMinutes] = useState(60)
  const [preview, setPreview] = useState<SchedulePreview | null>(null),
    [busy, setBusy] = useState(false)
  const { data: existing = [] } = useQuery({
    queryKey: ['plan', 'scheduleBusy', start, target],
    queryFn: () => api.plan.events({ startAt: new Date(`${start}T00:00:00`).getTime(), endAt: new Date(`${target}T23:59:59`).getTime() })
  })
  const generate = async (): Promise<void> => {
    setBusy(true)
    setPreview(null)
    try {
      setPreview(
        await api.plan.schedulePreview({
          goalId: goal.id,
          startAt: new Date(`${start}T00:00:00`).getTime(),
          targetAt: new Date(`${target}T23:59:59`).getTime(),
          weekdayMinutes: daily,
          avoidExternal: avoid,
          preference,
          sessionMinutes: minutes
        })
      )
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }
  const apply = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    try {
      await api.plan.scheduleApply(preview.id)
      onClose()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }
  const field = 'mt-1 block w-full rounded-lg border border-border bg-surface px-2 py-2 text-sm text-fg'
  const first = preview ? dayStart(preview.options.startAt) : 0
  const [offset, setOffset] = useState(0)
  const week = Array.from({ length: 7 }, (_, i) => addDays(first, offset * 7 + i))
  return (
    <D.Root open onOpenChange={(v) => !v && !busy && onClose()}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/25 backdrop-blur-sm" />
        <D.Content
          className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[min(94vw,900px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-float outline-none"
          data-testid="schedule-dialog"
        >
          <D.Title className="font-serif text-lg text-fg">
            {t('plan.generatePlan')} · {goal.title}
          </D.Title>
          <D.Description className="mt-2 text-xs text-muted">{t('plan.previewHint')}</D.Description>
          {!preview ? (
            <div className="mt-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-muted">
                  {t('plan.startDate')}
                  <input
                    type="date"
                    aria-label={t('plan.startDate')}
                    className={field}
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                  />
                </label>
                <label className="text-xs text-muted">
                  {t('goals.target')}
                  <input
                    type="date"
                    aria-label={t('goals.target')}
                    className={field}
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  />
                </label>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                  <label key={d} className="text-xs text-muted">
                    {t(`plan.days.${d}`)}
                    <input
                      type="number"
                      aria-label={t(`plan.days.${d}`)}
                      min="0"
                      max="1440"
                      className={field}
                      value={daily[d]}
                      onChange={(e) => setDaily(daily.map((v, i) => (i === d ? Number(e.target.value) : v)))}
                    />
                  </label>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-xs text-muted">
                  {t('plan.preference')}
                  <select
                    className={field}
                    value={preference}
                    onChange={(e) => setPreference(e.target.value as ScheduleInput['preference'])}
                  >
                    {['morning', 'afternoon', 'evening'].map((p) => (
                      <option key={p} value={p}>
                        {t(`plan.preferences.${p}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-muted">
                  {t('plan.sessionMinutes')}
                  <input
                    type="number"
                    min="30"
                    max="120"
                    className={field}
                    value={minutes}
                    onChange={(e) => setMinutes(Number(e.target.value))}
                  />
                </label>
              </div>
              <label className="flex gap-2 text-xs text-fg">
                <input type="checkbox" checked={avoid} onChange={(e) => setAvoid(e.target.checked)} />
                {t('plan.avoidExternal')}
              </label>
              <label className="flex gap-2 text-xs text-fg">
                <input
                  type="checkbox"
                  checked={settings?.plan.autoComplete ?? true}
                  onChange={(e) => update.mutate({ plan: { autoComplete: e.target.checked } })}
                />
                {t('plan.autoComplete')}
              </label>
            </div>
          ) : (
            <div className="mt-4 space-y-4" data-testid="schedule-preview">
              <p className="text-sm text-fg">
                {t('plan.previewSummary', {
                  hours: (daily.reduce((a, b) => a + b, 0) / 60).toFixed(1),
                  count: preview.sessions.length,
                  unplaced: (preview.unplacedMinutes / 60).toFixed(1)
                })}
              </p>
              <p className="text-xs text-muted">{preview.tradeoffs}</p>
              <ul className="space-y-2">
                {preview.phases.map((p, i) => (
                  <li key={i} className="rounded-lg bg-sunken p-3 text-sm text-fg">
                    {p.title} · {localDay(p.startAt)}—{localDay(addDays(p.endAt, -1))}
                    <p className="text-xs text-muted">{p.objective}</p>
                  </li>
                ))}
              </ul>
              <div className="flex justify-between">
                <Button size="sm" variant="ghost" onClick={() => setOffset(Math.max(0, offset - 1))}>
                  {t('plan.previous')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setOffset(offset + 1)}>
                  {t('plan.next')}
                </Button>
              </div>
              <div className="overflow-x-auto">
                <div className="grid min-w-[650px] grid-cols-7 gap-1" aria-label={t('plan.previewCalendar')}>
                  {week.map((day) => (
                    <div key={day} className="relative h-[360px] rounded-lg border border-border bg-sunken/40">
                      <p className="border-b border-border py-1 text-center text-2xs text-muted">
                        {new Date(day).toLocaleDateString(i18n.language, { month: 'numeric', day: 'numeric', weekday: 'short' })}
                      </p>
                      {[
                        ...existing.filter((e) => dayStart(e.startAt) === day && !e.allDay).map((e) => ({ ...e, ghost: false })),
                        ...preview.sessions.filter((s) => dayStart(s.startAt) === day).map((s) => ({ ...s, ghost: true }))
                      ].map((s, i) => {
                        const hour = (s.startAt - day) / 3600000
                        return (
                          <div
                            key={i}
                            title={`${s.title} ${new Date(s.startAt).toLocaleTimeString()}`}
                            className={`absolute right-1 left-1 overflow-hidden rounded px-1 text-[10px] ${s.ghost ? 'border border-accent/50 bg-accent/20 text-accent opacity-70' : 'bg-surface text-muted'}`}
                            style={{ top: 28 + Math.max(0, hour - 6) * 18, height: Math.max(18, ((s.endAt - s.startAt) / 3600000) * 18) }}
                          >
                            {s.title}
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            {preview && (
              <Button
                disabled={busy}
                onClick={() => {
                  setPreview(null)
                  setOffset(0)
                }}
              >
                {t('plan.adjustParameters')}
              </Button>
            )}
            <Button disabled={busy || !start || !target} onClick={() => void generate()}>
              {busy ? t('plan.generating') : preview ? t('plan.regenerate') : t('plan.generate')}
            </Button>
            {preview && (
              <Button variant="primary" disabled={busy} onClick={() => void apply()}>
                {t('plan.apply')}
              </Button>
            )}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
