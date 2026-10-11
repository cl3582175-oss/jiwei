import { useRef, useState, type ReactNode, type PointerEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { Goal } from '@shared/types'
import { addDays, dayStart, localDay, type GoalMilestone, type GoalPhase } from '@shared/plan'
import { api } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { errText } from '../chat/useChat'
import { PlanDialog, field } from './ui'
import { NotePicker } from '../notes/NotePicker'
import { SourcePicker } from '../workspace/SourcePicker'

const DAY_WIDTH = 18
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
    const delta = Math.round((e.clientX - d.x) / DAY_WIDTH)
    if (delta) onShift(delta, d.edge)
    else onOpen()
  }
  return (
    <button
      data-testid={phase ? 'timeline-phase' : 'timeline-milestone'}
      style={style}
      className="absolute h-7 touch-none cursor-grab rounded border border-accent/30 bg-accent-soft px-2 text-left text-xs text-fg"
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
    <PlanDialog title={phase ? phase.title : t('plan.newPhase')} onClose={onClose}>
      <label className="block text-xs text-muted">
        {t('plan.phaseTitle')}
        <input className={field} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
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
      <div className="flex gap-2"><Button onClick={() => setNotePicker(true)}>{t('plan.linkNotes')}</Button><Button onClick={() => setSourcePicker(true)}>{t('plan.linkSources')}</Button></div>
      <div className="flex flex-wrap gap-2">{noteIds.map((id) => <span key={id} className="inline-flex items-center rounded bg-sunken"><Button size="sm" onClick={() => useApp.getState().openNote(id)}>{notes.find((n) => n.id === id)?.title || t('common.untitled')}</Button><Button size="icon-sm" aria-label={t('plan.unlink')} onClick={() => setNoteIds(noteIds.filter((n) => n !== id))}>×</Button></span>)}{sourceIds.map((id) => <span key={id} className="inline-flex items-center rounded bg-sunken"><Button size="sm" onClick={() => useApp.getState().openSource(id)}>{sources.find((n) => n.id === id)?.title || t('common.untitled')}</Button><Button size="icon-sm" aria-label={t('plan.unlink')} onClick={() => setSourceIds(sourceIds.filter((n) => n !== id))}>×</Button></span>)}</div>
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
      <div className="flex gap-2">
        <Button disabled={!title.trim() || end <= start} variant="primary" onClick={() => void save()}>
          {t('common.save')}
        </Button>
        {phase && (
          <Button
            onClick={() =>
              void api.plan
                .phaseRemove(phase.id)
                .then(onClose)
                .catch((e) => toast.error(errText(e)))
            }
          >
            {t('common.delete')}
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
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
    <PlanDialog title={milestone ? milestone.title : t('plan.newMilestone')} onClose={onClose}>
      <label className="block text-xs text-muted">
        {t('plan.milestoneTitle')}
        <input className={field} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="block text-xs text-muted">
        {t('plan.startDate')}
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
      <div className="flex gap-2">
        <Button variant="primary" disabled={!title.trim()} onClick={() => void save()}>
          {t('common.save')}
        </Button>
        {milestone && (
          <>
            <Button onClick={() => void save(true)}>{t('plan.done')}</Button>
            <Button onClick={() => void api.plan.milestoneRemove(milestone.id).then(onClose)}>{t('common.delete')}</Button>
          </>
        )}
        <Button variant="ghost" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
    </PlanDialog>
  )
}

export function Timeline({ goal }: { goal: Goal }) {
  const { t } = useTranslation()
  const { data: phases = [] } = useQuery({ queryKey: ['plan', 'phases', goal.id], queryFn: () => api.plan.phases(goal.id) })
  const { data: milestones = [] } = useQuery({ queryKey: ['plan', 'milestones', goal.id], queryFn: () => api.plan.milestones(goal.id) })
  const { data: actions = [] } = useQuery({ queryKey: ['actions', 'goal', goal.id], queryFn: () => api.actions.list() })
  const [phase, setPhase] = useState<GoalPhase | 'new' | null>(null),
    [milestone, setMilestone] = useState<GoalMilestone | 'new' | null>(null)
  const start = dayStart(goal.startAt ?? addDays(dayStart(), -7)),
    end = Math.max(start + 86400000, goal.targetAt ?? addDays(dayStart(), 60))
  const days = Math.ceil((end - start) / 86400000),
    width = Math.max(800, days * DAY_WIDTH),
    x = (at: number): number => Math.max(0, Math.min(width, ((dayStart(at) - start) / 86400000) * DAY_WIDTH))
  const failure = (e: unknown): void => {
    toast.error(errText(e))
  }
  return (
    <section className="mt-6 min-w-0" data-testid="timeline">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="mr-auto text-sm font-semibold text-fg">{t('plan.timeline')}</h3>
        <Button size="sm" onClick={() => setPhase('new')}>
          {t('plan.newPhase')}
        </Button>
        <Button size="sm" onClick={() => setMilestone('new')}>
          {t('plan.newMilestone')}
        </Button>
      </div>
      <div className="w-full overflow-x-auto rounded-xl border border-border">
        <div className="relative" style={{ width, minHeight: 100 + phases.length * 58 + milestones.length * 32 }}>
          <div className="relative h-8 border-b border-border">
            {Array.from({ length: Math.ceil(days / 7) }, (_, i) => (
              <span key={i} className="absolute border-l border-border pl-1 text-[10px] text-subtle" style={{ left: i * 7 * DAY_WIDTH }}>
                {localDay(addDays(start, i * 7)).slice(5)}
              </span>
            ))}
          </div>
          <div
            className="pointer-events-none absolute inset-y-0 z-10 border-l border-accent/60"
            style={{ left: x(Date.now()) }}
            title={t('plan.today')}
          />
          {goal.targetAt && (
            <div
              className="pointer-events-none absolute inset-y-0 border-l border-danger/50"
              style={{ left: x(goal.targetAt) }}
              title={t('goals.target')}
            />
          )}
          {phases.map((p, i) => (
            <div key={p.id} className="absolute inset-x-0 h-14" style={{ top: 40 + i * 58 }}>
              <Draggable
                phase
                style={{ left: x(p.startAt), width: Math.max(60, x(p.endAt) - x(p.startAt)) }}
                onOpen={() => setPhase(p)}
                onShift={(delta, edge) => {
                  const startAt = edge === 'end' ? p.startAt : addDays(p.startAt, delta),
                    endAt = edge === 'start' ? p.endAt : addDays(p.endAt, delta)
                  if (endAt > startAt) void api.plan.phaseSave({ ...p, startAt, endAt }).catch(failure)
                }}
              >
                <span className="pointer-events-none block truncate">
                  {p.title} · {Math.round(p.progress * 100)}%
                </span>
                <span className="pointer-events-none absolute bottom-0 left-0 h-1 bg-accent/40" style={{ width: `${p.progress * 100}%` }} />
              </Draggable>
              {actions
                .filter((a) => a.phaseId === p.id && a.dueAt && a.status !== 'dropped')
                .map((a) => (
                  <button
                    key={a.id}
                    title={a.title}
                    className="absolute top-9 size-2 rounded-full bg-accent"
                    style={{ left: x(a.dueAt!) }}
                    onClick={() => useApp.getState().setView('reflect')}
                  />
                ))}
            </div>
          ))}
          {milestones.map((m, i) => (
            <Draggable
              key={m.id}
              style={{ top: 48 + phases.length * 58 + i * 32, left: x(m.at), maxWidth: 250 }}
              onOpen={() => setMilestone(m)}
              onShift={(delta) => void api.plan.milestoneSave({ ...m, at: addDays(m.at, delta) }).catch(failure)}
            >
              <span className="pointer-events-none">
                ◇ {m.title}
                {m.doneAt ? ' ✓' : ''}
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
