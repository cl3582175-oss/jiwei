import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, CalendarClock, ChevronDown, ChevronLeft, ChevronRight, Loader2, Sparkles } from 'lucide-react'
import type { Goal } from '@shared/types'
import { addDays, dayStart, type ScheduleInput, type SchedulePreview } from '@shared/plan'
import { api, cn, toDateInput } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { useSettings, useUpdateSettings } from '@/lib/queries'
import { tintFor } from '@/lib/tint'
import { errText } from '../chat/useChat'
import { PlanDialog, Segmented, WeekdayHours, field, splitWeekly } from './ui'

// AI 排期（v0.8）：先填参数 → AI 生成 → 主进程校验后的预览（不写库）→ 确认写入。
// 审查后的界面：可投入时间按小时、工作日 / 周末分开；生成时有明确的等待状态；
// 预览按周列出每天的学习时段（不按时间轴缩放，避免挤在一起看不清），取舍说明默认折叠。

const hm = (t: number): string => `${String(new Date(t).getHours()).padStart(2, '0')}:${String(new Date(t).getMinutes()).padStart(2, '0')}`

/** 分钟 → 小时文本：整数不带小数（25 而不是 25.0） */
const fmtHours = (m: number): string => String(Math.round(m / 6) / 10)

export function ScheduleDialog({ goal, onClose }: { goal: Goal; onClose: () => void }) {
  const { t, i18n } = useTranslation(),
    { data: settings } = useSettings(),
    update = useUpdateSettings()
  const [start, setStart] = useState(toDateInput(Math.max(goal.startAt ?? Date.now(), Date.now())))
  const [target, setTarget] = useState(toDateInput(goal.targetAt ?? addDays(dayStart(), 30)))
  const [daily, setDaily] = useState(goal.weekdayMinutes ?? splitWeekly(goal.weeklyMinutes ?? 300))
  const [avoid, setAvoid] = useState(true),
    [preference, setPreference] = useState<ScheduleInput['preference']>('evening'),
    [minutes, setMinutes] = useState(60)
  const [preview, setPreview] = useState<SchedulePreview | null>(null),
    [busy, setBusy] = useState(false),
    [why, setWhy] = useState(false),
    [offset, setOffset] = useState(0)
  const { data: existing = [] } = useQuery({
    queryKey: ['plan', 'scheduleBusy', start, target],
    queryFn: () => api.plan.events({ startAt: new Date(`${start}T00:00:00`).getTime(), endAt: new Date(`${target}T23:59:59`).getTime() })
  })
  const generate = async (): Promise<void> => {
    setBusy(true)
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
      setOffset(0)
      setWhy(false)
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const apply = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    try {
      await api.plan.scheduleApply(preview.id)
      toast.success(t('plan.applied', { count: preview.sessions.length }))
      onClose()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const first = preview ? addDays(dayStart(preview.options.startAt), -((new Date(preview.options.startAt).getDay() + 6) % 7)) : 0
  const weeks = preview ? Math.max(1, Math.ceil((dayStart(preview.options.targetAt) - first) / (7 * 86400000)) + 1) : 1
  const week = Array.from({ length: 7 }, (_, i) => addDays(first, offset * 7 + i))
  const tint = tintFor(goal.id, goal.color)
  const total = daily.reduce((a, b) => a + b, 0)
  return (
    <PlanDialog
      testId="schedule-dialog"
      title={`${t('plan.generatePlan')} · ${goal.title}`}
      description={t('plan.previewHint')}
      size="lg"
      onClose={() => !busy && onClose()}
      footer={
        <>
          {preview && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPreview(null)}>
              <ChevronLeft />
              {t('plan.adjustParameters')}
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            {preview ? (
              <>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void generate()}>
                  {busy && <Loader2 className="animate-spin" />}
                  {t('plan.regenerate')}
                </Button>
                <Button variant="primary" size="sm" disabled={busy || !preview.sessions.length} onClick={() => void apply()}>
                  {t('plan.apply')}
                </Button>
              </>
            ) : (
              <Button variant="primary" size="sm" disabled={busy || !start || !target || !total} onClick={() => void generate()}>
                {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {busy ? t('plan.generating') : t('plan.generate')}
              </Button>
            )}
          </div>
        </>
      }
    >
      {!preview ? (
        <div className={cn('space-y-5 transition-opacity', busy && 'pointer-events-none opacity-60')}>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-muted">
              {t('plan.startDate')}
              <input type="date" aria-label={t('plan.startDate')} className={field} value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label className="text-xs text-muted">
              {t('goals.target')}
              <input type="date" aria-label={t('goals.target')} className={field} value={target} onChange={(e) => setTarget(e.target.value)} />
            </label>
          </div>
          <div className="text-xs text-muted">
            <span className="mb-1.5 block">{t('plan.available')}</span>
            <WeekdayHours value={daily} onChange={setDaily} label={t('plan.available')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-muted">
              {t('plan.preference')}
              <select aria-label={t('plan.preference')} className={field} value={preference} onChange={(e) => setPreference(e.target.value as ScheduleInput['preference'])}>
                {(['morning', 'afternoon', 'evening'] as const).map((p) => (
                  <option key={p} value={p}>
                    {t(`plan.preferences.${p}`)}
                  </option>
                ))}
              </select>
            </label>
            <div className="text-xs text-muted">
              {t('plan.sessionMinutes')}
              <div className="mt-1">
                <Segmented
                  label={t('plan.sessionMinutes')}
                  value={String(minutes)}
                  onChange={(v) => setMinutes(Number(v))}
                  options={['30', '45', '60', '90', '120'].map((v) => ({ value: v, label: v }))}
                />
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <label className="flex w-fit items-center gap-2 text-sm text-fg">
              <input type="checkbox" className="accent-[var(--accent)]" checked={avoid} onChange={(e) => setAvoid(e.target.checked)} />
              {t('plan.avoidExternal')}
            </label>
            <label className="flex w-fit items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                className="accent-[var(--accent)]"
                checked={settings?.plan.autoComplete ?? true}
                onChange={(e) => update.mutate({ plan: { autoComplete: e.target.checked } })}
              />
              {t('plan.autoComplete')}
            </label>
          </div>
          {busy && (
            <p className="flex items-center gap-2 rounded-xl bg-accent-soft/50 px-3 py-2 text-xs text-accent">
              <Loader2 className="size-3.5 animate-spin" />
              {t('plan.generatingHint')}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4" data-testid="schedule-preview" data-tint={tint}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-full bg-[var(--tint)] px-3 py-1 text-[var(--tint-ink)]">
              {t('plan.previewHours', { hours: fmtHours(total) })}
            </span>
            <span className="rounded-full bg-[var(--tint)] px-3 py-1 text-[var(--tint-ink)]">{t('plan.previewSessions', { count: preview.sessions.length })}</span>
            {preview.unplacedMinutes > 0 && (
              <Tip label={t('plan.unplacedHint')}>
                <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-3 py-1 text-warning">
                  <AlertTriangle className="size-3.5" />
                  {t('plan.previewUnplaced', { hours: fmtHours(preview.unplacedMinutes) })}
                </span>
              </Tip>
            )}
            <span className="sr-only">
              {t('plan.previewSummary', {
                hours: fmtHours(total),
                count: preview.sessions.length,
                unplaced: fmtHours(preview.unplacedMinutes)
              })}
            </span>
          </div>
          {preview.tradeoffs && (
            <div className="rounded-xl bg-sunken/60 px-3.5 py-2.5">
              <button onClick={() => setWhy(!why)} className="flex w-full items-center gap-1.5 text-left text-xs font-medium text-muted hover:text-fg" aria-expanded={why}>
                <ChevronDown className={cn('size-3.5 transition-transform', !why && '-rotate-90')} />
                {t('plan.tradeoffs')}
              </button>
              <p className={cn('mt-1 text-xs leading-relaxed whitespace-pre-line text-muted', !why && 'line-clamp-2')}>{preview.tradeoffs}</p>
            </div>
          )}
          <ol className="space-y-1.5">
            {preview.phases.map((p, i) => (
              <li key={i} className="flex items-start gap-3 rounded-xl border border-border/70 px-3.5 py-2.5">
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-[var(--tint)] text-[11px] font-medium text-[var(--tint-ink)] tabular-nums">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-fg">
                    <span className="font-medium">{p.title}</span>
                    <span className="text-2xs text-subtle tabular-nums">
                      {new Date(p.startAt).toLocaleDateString(i18n.language, { month: 'numeric', day: 'numeric' })} –{' '}
                      {new Date(addDays(p.endAt, -1)).toLocaleDateString(i18n.language, { month: 'numeric', day: 'numeric' })}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{p.objective}</p>
                </div>
              </li>
            ))}
          </ol>
          <div>
            <div className="mb-2 flex items-center gap-1">
              <span className="mr-auto text-xs font-medium text-muted">{t('plan.previewCalendar')}</span>
              <Button size="icon-sm" variant="ghost" aria-label={t('plan.previous')} disabled={offset === 0} onClick={() => setOffset(offset - 1)}>
                <ChevronLeft />
              </Button>
              <span className="text-xs text-muted tabular-nums">
                {t('plan.weekOf', { n: offset + 1, total: weeks })}
              </span>
              <Button size="icon-sm" variant="ghost" aria-label={t('plan.next')} disabled={offset >= weeks - 1} onClick={() => setOffset(offset + 1)}>
                <ChevronRight />
              </Button>
            </div>
            <div className="grid grid-cols-7 gap-1.5" aria-label={t('plan.previewCalendar')}>
              {week.map((day) => {
                const sessions = preview.sessions.filter((s) => dayStart(s.startAt) === day)
                const busyHere = existing.filter((e) => dayStart(e.startAt) === day && !e.allDay)
                const outside = day < dayStart(preview.options.startAt) || day > preview.options.targetAt
                return (
                  <div key={day} className={cn('min-h-28 min-w-0 rounded-xl border border-border/70 p-1.5', outside && 'opacity-40')}>
                    <p className={cn('mb-1 text-center text-[11px] text-muted', day === dayStart() && 'font-medium text-accent')}>
                      {new Date(day).toLocaleDateString(i18n.language, { month: 'numeric', day: 'numeric', weekday: 'short' })}
                    </p>
                    {[
                      ...busyHere.map((e) => ({ key: e.id, title: e.title, startAt: e.startAt, endAt: e.endAt, ghost: false })),
                      ...sessions.map((s, i) => ({ key: `s${i}`, title: s.title, startAt: s.startAt, endAt: s.endAt, ghost: true }))
                    ]
                      .sort((a, b) => a.startAt - b.startAt)
                      .map((s) => (
                        <div
                          key={s.key}
                          title={`${s.title} · ${hm(s.startAt)}–${hm(s.endAt)}`}
                          className={cn(
                            'mb-1 rounded-md px-1.5 py-1 text-[10px] leading-tight',
                            s.ghost ? 'border-l-2 border-[var(--tint-ink)] bg-[var(--tint)] text-[var(--tint-ink)]' : 'bg-sunken text-subtle'
                          )}
                        >
                          <span className="flex items-center gap-1 tabular-nums opacity-80">
                            {!s.ghost && <CalendarClock className="size-2.5" />}
                            {hm(s.startAt)}
                          </span>
                          <span className="line-clamp-2">{s.title}</span>
                        </div>
                      ))}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </PlanDialog>
  )
}
