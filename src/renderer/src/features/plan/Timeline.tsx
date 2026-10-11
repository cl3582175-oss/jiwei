import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { Goal } from '@shared/types'
import { addDays, dayStart, localDay, type GoalMilestone, type GoalPhase } from '@shared/plan'
import { Check, Diamond, Plus, Trash2 } from 'lucide-react'
import { api, cn } from '@/lib/utils'
import { tintFor } from '@/lib/tint'
import { Tip } from '@/components/ui/primitives'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { errText } from '../chat/useChat'
import { PlanDialog, field } from './ui'
import { NotePicker } from '../notes/NotePicker'
import { SourcePicker } from '../workspace/SourcePicker'

// 每天的宽度随容器变化（范围短时铺满），拖动换算用当前值
const MIN_DAY = 14
let dayWidth = 18
function Draggable({
  children,
  onShift,
  onOpen,
  style,
  phase
}: {
  children: ReactNode
  onShift: (days: number, edge?: string) => void
  onOpen: () => void
  style: React.CSSProperties
  phase?: boolean
}) {
  const pointer = useRef<{ x: number; edge?: string } | null>(null)
  const up = (e: PointerEvent<HTMLButtonElement>): void => {
    const d = pointer.current
    pointer.current = null
    if (!d) return
    const delta = Math.round((e.clientX - d.x) / dayWidth)
    if (delta) onShift(delta, d.edge)
    else onOpen()
  }
  return (
    <button
      data-testid={phase ? 'timeline-phase' : 'timeline-milestone'}
      style={style}
      className={cn(
        'absolute h-7 touch-none cursor-grab text-left text-xs text-[var(--tint-ink)] active:cursor-grabbing',
        phase
          ? 'overflow-clip rounded-md border-l-[3px] border-[var(--tint-ink)] bg-[var(--tint)] px-2 shadow-[0_1px_0_rgb(0_0_0/0.04)] transition-shadow hover:shadow-[var(--shadow-2)]'
          : 'flex items-center rounded-md px-1 hover:bg-[var(--tint)]'
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        pointer.current = { x: e.clientX, edge: (e.target as HTMLElement).dataset.edge }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerUp={up}
      onPointerCancel={() => {
        pointer.current = null
      }}
      onClick={(e) => {
        if (e.detail === 0) onOpen()
      }}
    >
      {phase && <span data-edge="start" className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize" />}
      {children}
      {phase && <span data-edge="end" className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize" />}
    </button>
  )
}

function PhaseDialog({ goal, phase, position, onClose }: { goal: Goal; phase?: GoalPhase; position: number; onClose: () => void }) {
  const { t } = useTranslation()
  const [title, setTitle] = useState(phase?.title ?? ''),
    [start, setStart] = useState(localDay(phase?.startAt ?? Date.now())),
    [end, setEnd] = useState(localDay(phase?.endAt ?? addDays(dayStart(), 7)))
  const [status, setStatus] = useState(phase?.status ?? 'planned'),
    [noteIds, setNoteIds] = useState(phase?.noteIds ?? []),
    [sourceIds, setSourceIds] = useState(phase?.sourceIds ?? [])
  const [notePicker, setNotePicker] = useState(false), [sourcePicker, setSourcePicker] = useState(false)
  const { data: notes = [] } = useQuery({ queryKey: ['phase-notes', noteIds], queryFn: async () => (await Promise.all(noteIds.map((id) => api.notes.get(id)))).filter((n) => n !== null) })
  const { data: sources = [] } = useQuery({ queryKey: ['phase-sources', sourceIds], queryFn: async () => (await Promise.all(sourceIds.map((id) => api.sources.get(id)))).filter((n) => n !== null) })
  const { data: mistakes = [] } = useQuery({ queryKey: ['phase-mistakes'], queryFn: () => api.mistakes.list({}) })
  const { data: actions = [] } = useQuery({ queryKey: ['actions'], queryFn: () => api.actions.list() })
  const save = async (): Promise<void> => {
    try {
      await api.plan.phaseSave({
        id: phase?.id,
        goalId: goal.id,
        title,
        startAt: new Date(`${start}T00:00:00`).getTime(),
        endAt: new Date(`${end}T00:00:00`).getTime(),
        position,
        status,
        noteIds,
        sourceIds
      })
      onClose()
    } catch (e) {
      toast.error(errText(e))
    }
  }
  return (
    <PlanDialog
      title={phase ? phase.title : t('plan.newPhase')}
      onClose={onClose}
      footer={
        <>
          {phase && (
            <Button
              variant="ghost"
              size="sm"
              className="text-danger hover:bg-danger-soft hover:text-danger"
              onClick={() =>
                void api.plan
                  .phaseRemove(phase.id)
                  .then(onClose)
                  .catch((e) => toast.error(errText(e)))
              }
            >
              <Trash2 />
              {t('common.delete')}
            </Button>
          )}
          <Button className="ml-auto" size="sm" disabled={!title.trim() || end <= start} variant="primary" onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <label className="block text-xs text-muted">
        {t('plan.phaseTitle')}
        <input className={field} autoFocus aria-label={t('plan.phaseTitle')} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-muted">
          {t('plan.startDate')}
          <input className={field} type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="text-xs text-muted">
          {t('plan.endDate')}
          <input className={field} type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
      </div>
      <label className="block text-xs text-muted">
        {t('plan.phaseState')}
        <select className={field} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          {(['planned', 'active', 'done'] as const).map((k) => (
            <option value={k} key={k}>
              {t(`plan.phaseStates.${k}`)}
            </option>
          ))}
        </select>
      </label>
      <div>
        <div className="flex items-center gap-1">
          <span className="mr-auto text-xs text-muted">{t('plan.materials')}</span>
          <Button size="sm" variant="ghost" onClick={() => setNotePicker(true)}>
            <Plus />
            {t('plan.linkNotes')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSourcePicker(true)}>
            <Plus />
            {t('plan.linkSources')}
          </Button>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {[
            ...noteIds.map((id) => ({ id, kind: 'note' as const, title: notes.find((n) => n.id === id)?.title })),
            ...sourceIds.map((id) => ({ id, kind: 'source' as const, title: sources.find((n) => n.id === id)?.title }))
          ].map((it) => (
            <span key={it.id} className="inline-flex max-w-full items-center rounded-full bg-sunken pr-1 pl-2.5 text-xs text-fg">
              <button
                className="truncate py-1 hover:text-accent"
                onClick={() => (it.kind === 'note' ? useApp.getState().openNote(it.id) : useApp.getState().openSource(it.id))}
              >
                {it.title || t('common.untitled')}
              </button>
              <button
                aria-label={t('plan.unlink')}
                className="ml-1 grid size-5 place-items-center rounded-full text-subtle hover:bg-surface-hover hover:text-fg"
                onClick={() => (it.kind === 'note' ? setNoteIds(noteIds.filter((n) => n !== it.id)) : setSourceIds(sourceIds.filter((n) => n !== it.id)))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      </div>
      <NotePicker open={notePicker} onOpenChange={setNotePicker} title={t('plan.linkNotes')} onPick={(id) => setNoteIds([...new Set([...noteIds, id])])} />
      <SourcePicker open={sourcePicker} onOpenChange={setSourcePicker} onPick={(id) => setSourceIds([...new Set([...sourceIds, id])])} />
      {!!mistakes.filter((m) => m.noteId && noteIds.includes(m.noteId)).length && (
        <p className="text-xs text-muted">
          {t('plan.linkedMistakes', { count: mistakes.filter((m) => m.noteId && noteIds.includes(m.noteId)).length })}
        </p>
      )}
      {mistakes.filter((m) => m.noteId && noteIds.includes(m.noteId)).map((m) => <button key={m.id} className="block max-w-full truncate text-xs text-accent" onClick={() => useApp.getState().openNote(m.noteId)}>{m.question}</button>)}
      {phase &&
        actions
          .filter((a) => a.goalId === goal.id)
          .map((a) => (
            <label key={a.id} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={a.phaseId === phase.id}
                onChange={(e) =>
                  void api.actions.update(a.id, { phaseId: e.target.checked ? phase.id : null }).catch((err) => toast.error(errText(err)))
                }
              />
              {a.title}
            </label>
          ))}
    </PlanDialog>
  )
}

function MilestoneDialog({ goal, milestone, onClose }: { goal: Goal; milestone?: GoalMilestone; onClose: () => void }) {
  const { t } = useTranslation(),
    [title, setTitle] = useState(milestone?.title ?? ''),
    [at, setAt] = useState(localDay(milestone?.at ?? Date.now()))
  const [phaseId, setPhaseId] = useState(milestone?.phaseId ?? '')
  const { data: phases = [] } = useQuery({ queryKey: ['plan', 'phases', goal.id], queryFn: () => api.plan.phases(goal.id) })
  const save = async (done = false): Promise<void> => {
    try {
      await api.plan.milestoneSave({
        id: milestone?.id,
        goalId: goal.id,
        phaseId: phaseId || null,
        title,
        at: new Date(`${at}T00:00:00`).getTime(),
        doneAt: done ? Date.now() : (milestone?.doneAt ?? null)
      })
      onClose()
    } catch (e) {
      toast.error(errText(e))
    }
  }
  return (
    <PlanDialog
      title={milestone ? milestone.title : t('plan.newMilestone')}
      size="sm"
      onClose={onClose}
      footer={
        <>
          {milestone && (
            <Button
              variant="ghost"
              size="sm"
              className="text-danger hover:bg-danger-soft hover:text-danger"
              onClick={() => void api.plan.milestoneRemove(milestone.id).then(onClose)}
            >
              <Trash2 />
              {t('common.delete')}
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            {milestone && !milestone.doneAt && (
              <Button size="sm" variant="outline" onClick={() => void save(true)}>
                <Check />
                {t('plan.done')}
              </Button>
            )}
            <Button size="sm" variant="primary" disabled={!title.trim()} onClick={() => void save()}>
              {t('common.save')}
            </Button>
          </div>
        </>
      }
    >
      <label className="block text-xs text-muted">
        {t('plan.milestoneTitle')}
        <input className={field} autoFocus aria-label={t('plan.milestoneTitle')} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="block text-xs text-muted">
        {t('plan.milestoneDate')}
        <input type="date" className={field} value={at} onChange={(e) => setAt(e.target.value)} />
      </label>
      <label className="block text-xs text-muted">
        {t('plan.phase')}
        <select className={field} value={phaseId} onChange={(e) => setPhaseId(e.target.value)}>
          <option value="">—</option>
          {phases.map((p) => (
            <option value={p.id} key={p.id}>
              {p.title}
            </option>
          ))}
        </select>
      </label>
    </PlanDialog>
  )
}

export function Timeline({ goal }: { goal: Goal }) {
  const { t, i18n } = useTranslation()
  const { data: phases = [] } = useQuery({ queryKey: ['plan', 'phases', goal.id], queryFn: () => api.plan.phases(goal.id) })
  const { data: milestones = [] } = useQuery({ queryKey: ['plan', 'milestones', goal.id], queryFn: () => api.plan.milestones(goal.id) })
  const { data: actions = [] } = useQuery({ queryKey: ['actions', 'goal', goal.id], queryFn: () => api.actions.list() })
  const [phase, setPhase] = useState<GoalPhase | 'new' | null>(null),
    [milestone, setMilestone] = useState<GoalMilestone | 'new' | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const [boxWidth, setBoxWidth] = useState(800)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setBoxWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const start = dayStart(Math.min(goal.startAt ?? addDays(dayStart(), -7), ...phases.map((p) => p.startAt), addDays(dayStart(), -7)))
  const end = Math.max(start + 86400000, goal.targetAt ?? addDays(dayStart(), 60), ...phases.map((p) => p.endAt), ...milestones.map((m) => m.at)) + 3 * 86400000
  const days = Math.ceil((end - start) / 86400000)
  // 范围短时铺满容器；长时每天至少 14px，可以横向滚动
  dayWidth = Math.max(MIN_DAY, boxWidth / days)
  const width = Math.max(boxWidth, days * dayWidth),
    x = (at: number): number => Math.max(0, Math.min(width, ((dayStart(at) - start) / 86400000) * dayWidth))
  // 打开时把今天放在左侧四分之一处
  useEffect(() => {
    const el = box.current
    if (el) el.scrollLeft = Math.max(0, x(Date.now()) - el.clientWidth / 4)
  }, [start, boxWidth]) // eslint-disable-line react-hooks/exhaustive-deps
  const failure = (e: unknown): void => {
    toast.error(errText(e))
  }
  const tint = tintFor(goal.id, goal.color)
  const ROW = 40
  const top = 34
  const height = top + Math.max(1, phases.length) * ROW + (milestones.length ? 44 : 8) + 8
  const label = (at: number): string => new Date(at).toLocaleDateString(i18n.language, { month: 'numeric', day: 'numeric' })
  const weeks = Math.ceil(days / 7)
  return (
    <section className="mt-6 min-w-0" data-testid="timeline" data-tint={tint}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-medium text-fg">{t('plan.timeline')}</h3>
        <Button size="sm" variant="ghost" onClick={() => setPhase('new')}>
          <Plus />
          {t('plan.newPhase')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMilestone('new')}>
          <Diamond />
          {t('plan.newMilestone')}
        </Button>
      </div>
      <div ref={box} className="paper w-full overflow-x-auto rounded-2xl shadow-[var(--shadow-1)]">
        <div className="relative" style={{ width, height }}>
          {/* 周刻度 */}
          {Array.from({ length: weeks }, (_, i) => (
            <div key={i} className="absolute inset-y-0 border-l border-border/40" style={{ left: i * 7 * dayWidth }}>
              <span className="absolute top-2 left-1.5 text-[10px] whitespace-nowrap text-subtle tabular-nums">{label(addDays(start, i * 7))}</span>
            </div>
          ))}
          <div className="absolute inset-x-0 border-b border-border/60" style={{ top: 26 }} />
          {/* 今天、截止 */}
          <div className="pointer-events-none absolute inset-y-0 z-20" style={{ left: x(Date.now()) }}>
            <div className="h-full border-l border-accent" />
            <span className="absolute top-1 -translate-x-1/2 rounded-full bg-accent px-1.5 text-[10px] leading-4 whitespace-nowrap text-accent-fg">{t('plan.today')}</span>
          </div>
          {goal.targetAt && (
            <div className="pointer-events-none absolute inset-y-0 z-20" style={{ left: x(goal.targetAt) }}>
              <div className="h-full border-l border-dashed border-danger/70" />
              <span className="absolute top-1 -translate-x-1/2 rounded-full bg-danger-soft px-1.5 text-[10px] leading-4 whitespace-nowrap text-danger">{t('plan.deadline')}</span>
            </div>
          )}
          {phases.length === 0 && (
            <p className="absolute inset-x-0 text-center text-xs text-subtle" style={{ top: top + 10 }}>
              {t('plan.timelineEmpty')}
            </p>
          )}
          {phases.map((p, i) => (
            <div key={p.id} className="absolute inset-x-0" style={{ top: top + i * ROW, height: ROW }}>
              <Draggable
                phase
                style={{ left: x(p.startAt), width: Math.max(56, x(p.endAt) - x(p.startAt)), top: 6 }}
                onOpen={() => setPhase(p)}
                onShift={(delta, edge) => {
                  const startAt = edge === 'end' ? p.startAt : addDays(p.startAt, delta),
                    endAt = edge === 'start' ? p.endAt : addDays(p.endAt, delta)
                  if (endAt > startAt) void api.plan.phaseSave({ ...p, startAt, endAt }).catch(failure)
                }}
              >
                <span className="pointer-events-none absolute inset-y-0 left-0 rounded-l-md bg-[var(--tint-ink)]/15" style={{ width: `${p.progress * 100}%` }} />
                {/* 阶段起点滚出视野时，名称吸附在可见区域左侧 */}
                <span className="pointer-events-none sticky left-2 flex w-fit max-w-full items-center gap-1.5 truncate">
                  {p.status === 'done' && <Check className="size-3 shrink-0" />}
                  <span className="truncate">{p.title}</span>
                  <span className="shrink-0 opacity-60 tabular-nums">{Math.round(p.progress * 100)}%</span>
                </span>
              </Draggable>
              {actions
                .filter((a) => a.phaseId === p.id && a.dueAt && a.status !== 'dropped')
                .map((a) => (
                  <Tip key={a.id} label={a.title}>
                    <button
                      aria-label={a.title}
                      className={cn('absolute size-2 -translate-x-1/2 rounded-full ring-2 ring-surface', a.status === 'done' ? 'bg-subtle' : 'bg-[var(--tint-ink)]')}
                      style={{ left: x(a.dueAt!), top: ROW - 6 }}
                      onClick={() => useApp.getState().setView('reflect')}
                    />
                  </Tip>
                ))}
            </div>
          ))}
          {milestones.map((m) => (
            <Draggable
              key={m.id}
              style={{ top: top + Math.max(1, phases.length) * ROW + 8, left: x(m.at) - 8 }}
              onOpen={() => setMilestone(m)}
              onShift={(delta) => void api.plan.milestoneSave({ ...m, at: addDays(m.at, delta) }).catch(failure)}
            >
              <span className="pointer-events-none flex items-center gap-1.5 whitespace-nowrap">
                <Diamond className={cn('size-3.5 shrink-0', m.doneAt ? 'fill-[var(--tint-ink)]' : 'fill-surface')} />
                <span className={cn(m.doneAt && 'line-through opacity-60')}>{m.title}</span>
              </span>
            </Draggable>
          ))}
        </div>
      </div>
      {phase && (
        <PhaseDialog
          key={phase === 'new' ? 'new' : phase.id}
          goal={goal}
          phase={phase === 'new' ? undefined : phase}
          position={phase === 'new' ? phases.length : phase.position}
          onClose={() => setPhase(null)}
        />
      )}
      {milestone && (
        <MilestoneDialog
          key={milestone === 'new' ? 'new' : milestone.id}
          goal={goal}
          milestone={milestone === 'new' ? undefined : milestone}
          onClose={() => setMilestone(null)}
        />
      )}
    </section>
  )
}
