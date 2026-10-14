import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { UiNode } from '@shared/ui/catalog'
import { addDays, localDay } from '@shared/plan'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { openCitation } from '@/features/chat/MessageItem'
import { useMoney } from '@/lib/money'
import { DecisionBox, UsageBox } from './Tools'
import type { UiContext } from '../context'
import { ConfirmSheet, uiAction, type ConfirmItem } from '../ConfirmSheet'
import { readUiData, dataText, type DataNode, type UiData } from '../readData'

type Pending = { kind: 'schedule' | 'create' | 'complete'; items: ConfirmItem[] }
export function DataNodeView({ node, uiKey, ctx }: { node: DataNode; uiKey: string; ctx: UiContext }) {
  const { t, i18n } = useTranslation()
  const money = useMoney()
  const textOf = useCallback(
    (data: UiData): string =>
      data.type === 'usage'
        ? `${t('ui.today')}: ${money.format(data.summary.today)}\n${t('ui.month')}: ${money.format(data.summary.month)}`
        : dataText(data),
    [t, money]
  )
  const [pending, setPending] = useState<Pending | null>(null),
    [dirty, setDirty] = useState(false),
    [live, setLive] = useState(false)
  const state = ctx.states[uiKey] ?? {},
    snapshot = typeof state.snapshot === 'string' ? state.snapshot : undefined
  const snapshotMode = ctx.context === 'note' && snapshot !== undefined && !live
  const enabled = ctx.settings.dataAccess && !snapshotMode && !(node.type === 'decision' && !node.decisionId)
  const query = useQuery({ queryKey: ['ui-data', ctx.messageId, uiKey, node], queryFn: () => readUiData(node, ctx), enabled, retry: false })
  useEffect(() => {
    if (query.data && enabled) ctx.snapshot?.(uiKey, textOf(query.data))
    else if (!enabled && !snapshotMode) ctx.snapshot?.(uiKey, '')
  }, [query.data, uiKey, ctx, enabled, snapshotMode, textOf])
  useEffect(() => {
    const mark = (): void => setDirty(true)
    const off = [
      window.jiweiEvents.on('plan:changed', mark),
      window.jiweiEvents.on('notes:changed', mark),
      window.jiweiEvents.on('review:changed', mark),
      window.jiweiEvents.on('sources:changed', mark),
      window.jiweiEvents.on('segments:changed', mark),
      window.jiweiEvents.on('advisor:changed', mark),
      window.jiweiEvents.on('usage:changed', mark)
    ]
    return () => off.forEach((f) => f())
  }, [])
  const disabled = ctx.streaming || ctx.stopped || ctx.sharedWritesAllowed === false
  const data = enabled ? query.data : undefined
  const created = (state.created ?? {}) as Record<string, string>,
    completed = (state.completed ?? {}) as Record<string, boolean>
  const store = async (patch: Record<string, unknown>): Promise<void> => {
    ctx.setState(uiKey, patch)
    await ctx.flushState?.(uiKey)
  }
  const confirm = async (ids: string[]): Promise<void> => {
    if (!pending) return
    if (!(await api.ui.canShareDerived(ctx.messageId))) throw new Error(t('attach.reason.sharedWrite'))
    const written = { ...created },
      done = { ...completed }
    for (const id of ids) {
      if (pending.kind === 'complete') {
        if (done[id]) continue
        await api.actions.update(id, { status: 'done' })
        done[id] = true
        await store({ completed: { ...done } })
      } else {
        if (written[id]) continue
        if (pending.kind === 'schedule' && node.type === 'schedule') {
          const p = node.proposals![Number(id)],
            result = await api.plan.eventSave({
              title: p.title,
              kind: 'event',
              startAt: new Date(p.start).getTime(),
              endAt: new Date(p.end).getTime(),
              goalId: p.goalId
            })
          written[id] = result.id
        } else if (node.type === 'tasks') {
          const draft = node.drafts![Number(id)],
            result = await api.actions.create(draft.title, draft.due ? new Date(`${draft.due}T00:00`).getTime() : null)
          written[id] = result.id
        }
        await store({ created: { ...written } })
      }
    }
    setPending(null)
    if (enabled) await query.refetch()
  }
  const refresh = async (): Promise<void> => {
    setLive(true)
    setDirty(false)
    if (enabled) await query.refetch()
  }
  const reason = query.error instanceof Error ? query.error.message : String(query.error)
  const errors: Record<string, string> = {
    'note-unavailable': t('ui.errors.note'),
    'goal-unavailable': t('ui.errors.goal'),
    'excerpt-unavailable': t('ui.errors.excerpt'),
    'decision-unavailable': t('ui.errors.decision')
  }
  return (
    <div className="min-w-0 px-3 py-3">
      {!ctx.settings.dataAccess && !snapshotMode && <p className="mb-3 text-xs text-subtle">{t('ui.dataOff')}</p>}
      {snapshotMode ? (
        <div>
          <p className="whitespace-pre-wrap text-sm">{snapshot}</p>
          <button className={uiAction} disabled={!ctx.settings.dataAccess} onClick={() => void refresh()}>
            {t('ui.refresh')}
          </button>
        </div>
      ) : (
        <>
          {enabled && query.isPending && <p className="py-2 text-2xs text-subtle">{t('ui.loading')}</p>}
          {enabled && query.isError && (
            <p role="status" className="py-2 text-xs text-subtle">
              {errors[reason] ?? reason}
            </p>
          )}
          {node.type === 'schedule' && (
            <Schedule
              node={node}
              data={data?.type === 'schedule' ? data : undefined}
              uiKey={uiKey}
              ctx={ctx}
              disabled={disabled}
              created={created}
              onConfirm={(items) => setPending({ kind: 'schedule', items })}
            />
          )}
          {node.type === 'tasks' && (
            <div className="space-y-2">
              {data?.type === 'tasks' &&
                data.actions.map((a) => (
                  <label key={a.id} className="flex items-start gap-2 rounded-lg bg-sunken p-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 accent-accent"
                      aria-label={a.title}
                      checked={
                        a.status === 'done' ||
                        !!completed[a.id] ||
                        (pending?.kind === 'complete' && pending.items.some((i) => i.id === a.id))
                      }
                      disabled={disabled || !!completed[a.id]}
                      onChange={(e) => setPending(e.target.checked ? { kind: 'complete', items: [{ id: a.id, label: a.title }] } : null)}
                    />
                    <span>
                      {a.title}
                      {a.dueAt && <small className="block text-subtle">{new Date(a.dueAt).toLocaleDateString(i18n.language)}</small>}
                    </span>
                  </label>
                ))}
              {(node.drafts ?? []).map((draft, i) => (
                <div
                  key={i}
                  className={cn(
                    'rounded-lg border p-2 text-sm',
                    created[i] ? 'border-border' : 'border-dashed border-emph/60 bg-emph-soft/40'
                  )}
                >
                  <span
                    className={cn('mr-2 rounded px-1.5 py-0.5 text-2xs', created[i] ? 'bg-sunken text-subtle' : 'bg-emph-soft text-emph')}
                  >
                    {created[i] ? t('ui.saved') : t('ui.suggestion')}
                  </span>
                  {draft.title}
                  {draft.due && <small className="ml-2 text-subtle">{draft.due}</small>}
                </div>
              ))}
              {!!node.drafts?.length && (
                <button
                  className={uiAction}
                  disabled={disabled || node.drafts.every((_d, i) => !!created[i])}
                  onClick={() =>
                    setPending({
                      kind: 'create',
                      items: node.drafts!.flatMap((d, i) => (created[i] ? [] : [{ id: String(i), label: d.title, detail: d.due }]))
                    })
                  }
                >
                  {t('ui.action.createTasks')}
                </button>
              )}
            </div>
          )}
          {data?.type === 'note' && (
            <div>
              <button className="mb-2 text-sm font-medium text-accent" onClick={() => useApp.getState().openNote(data.note.id)}>
                {data.note.title}
              </button>
              <div className="space-y-2">
                {data.rows.map((row) => (
                  <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3 border-t border-border/60 py-2 text-xs">
                    <p className="whitespace-pre-wrap text-muted">{row.cue}</p>
                    <p className="whitespace-pre-wrap">{row.body}</p>
                  </div>
                ))}
              </div>
              <button className={uiAction} onClick={() => useApp.getState().openNote(data.note.id)}>
                {t('ui.open')}
              </button>
            </div>
          )}
          {data?.type === 'excerpt' && (
            <blockquote className="rounded-r-lg border-l-[3px] border-viz-8 bg-sunken py-2.5 pr-3 pl-3.5">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{data.text}</p>
              <button className="mt-2 text-xs text-accent" onClick={() => data.citation && openCitation(data.citation)}>
                {data.title}
                {data.citation?.locator ? ` · ${data.citation.locator}` : ''}
              </button>
            </blockquote>
          )}
          {data?.type === 'mastery' && <Mastery data={data} />}
          {node.type === 'decision' && (
            <DecisionBox
              node={node}
              decision={data?.type === 'decision' ? data.decision : undefined}
              uiKey={uiKey}
              ctx={ctx}
              disabled={disabled}
            />
          )}
          {node.type === 'usage' && data?.type === 'usage' && <UsageBox node={node} summary={data.summary} />}
        </>
      )}
      {dirty && enabled && (
        <button className="mt-3 text-2xs text-accent" onClick={() => void refresh()}>
          {t('ui.dataChanged')} · {t('ui.refresh')}
        </button>
      )}
      {ctx.context === 'note' && live && data && (
        <button className={cn(uiAction, 'mt-2')} onClick={() => ctx.setState(uiKey, { snapshot: textOf(data), snapshotData: data })}>
          {t('ui.updateSnapshot')}
        </button>
      )}
      {pending && (
        <ConfirmSheet
          key={`${pending.kind}:${pending.items.map((i) => i.id).join(',')}`}
          items={pending.items}
          target={t(pending.kind === 'schedule' ? 'ui.target.calendar' : 'ui.target.tasks')}
          onCancel={() => setPending(null)}
          onConfirm={confirm}
        />
      )}
    </div>
  )
}

function Schedule({
  node,
  data,
  uiKey,
  ctx,
  disabled,
  created,
  onConfirm
}: {
  node: Extract<UiNode, { type: 'schedule' }>
  data?: Extract<UiData, { type: 'schedule' }>
  uiKey: string
  ctx: UiContext
  disabled: boolean
  created: Record<string, string>
  onConfirm(items: ConfirmItem[]): void
}) {
  const { t, i18n } = useTranslation()
  const excluded = (ctx.states[uiKey]?.excluded ?? {}) as Record<string, boolean>
  const days: string[] = []
  for (let date = new Date(`${node.range.from}T00:00`).getTime(); localDay(date) <= node.range.to; date = addDays(date, 1))
    days.push(localDay(date))
  const selected = (node.proposals ?? []).flatMap((p, i) =>
    excluded[i] || created[i] ? [] : [{ id: String(i), label: p.title, detail: `${p.start} – ${p.end}` }]
  )
  return (
    <div>
      <div
        className="grid min-w-0 gap-2"
        style={{ gridTemplateColumns: ctx.compact || days.length > 7 ? 'minmax(0,1fr)' : `repeat(${days.length},minmax(0,1fr))` }}
      >
        {days.map((day) => {
          const start = new Date(`${day}T00:00`).getTime(),
            end = addDays(start, 1),
            events = (data?.events ?? []).filter((e) => e.startAt < end && e.endAt > start && !Object.values(created).includes(e.id))
          // 空档只在白天（8:00–22:00）里找，并略去不足 30 分钟的零碎时间；整天都空就显示一条“全天空闲”
          const dayFrom = start + 8 * 3600_000,
            dayTo = start + 22 * 3600_000
          const free: { start: number; end: number }[] = []
          let cursor = dayFrom
          for (const e of [...events].sort((a, b) => a.startAt - b.startAt)) {
            if (e.startAt > cursor) free.push({ start: cursor, end: Math.min(dayTo, e.startAt) })
            cursor = Math.max(cursor, Math.min(dayTo, e.endAt))
          }
          if (cursor < dayTo) free.push({ start: cursor, end: dayTo })
          const slots = free.filter((f) => f.end - f.start >= 30 * 60_000)
          const clock = (v: number): string =>
            v === end ? '24:00' : new Date(v).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit', hour12: false })
          return (
            <div key={day} className="min-w-0 space-y-2">
              <p className="text-center text-2xs font-medium">
                {new Date(`${day}T00:00`).toLocaleDateString(i18n.language, { weekday: 'short', month: 'numeric', day: 'numeric' })}
              </p>
              {events.map((e) => (
                <div
                  data-testid="ui-existing-event"
                  key={e.id}
                  className="rounded-md border-l-[3px] border-viz-1 bg-sunken p-2 text-2xs text-muted"
                >
                  <p className="font-medium text-fg">{e.title}</p>
                  <p>
                    {clock(e.startAt)}–{clock(e.endAt)}
                  </p>
                </div>
              ))}
              {data &&
                (slots.length === 1 && !events.length ? (
                  <div className="rounded-md border border-dashed border-border p-1.5 text-center text-2xs text-subtle">
                    {t('ui.freeDay')}
                  </div>
                ) : (
                  slots.map((slot, i) => (
                    <div key={i} className="rounded-md border border-dashed border-border p-1.5 text-2xs text-subtle">
                      {t('ui.free')} {clock(slot.start)}–{clock(slot.end)}
                    </div>
                  ))
                ))}
              {(node.proposals ?? []).flatMap((p, i) =>
                p.start.slice(0, 10) === day
                  ? [
                      <label
                        key={i}
                        className={cn(
                          'block rounded-md border p-2 text-2xs',
                          created[i] ? 'border-l-[3px] border-viz-1 bg-sunken' : 'border-dashed border-emph/60 bg-emph-soft/40'
                        )}
                      >
                        <span className={cn('mb-1 block font-medium', created[i] ? 'text-viz-1' : 'text-emph')}>
                          {created[i] ? t('ui.done.scheduled') : t('ui.suggestion')}
                        </span>
                        <span className="flex items-start gap-1">
                          <input
                            type="checkbox"
                            className="mt-0.5 accent-accent"
                            aria-label={p.title}
                            disabled={disabled || !!created[i]}
                            checked={!excluded[i]}
                            onChange={(e) => ctx.setState(uiKey, { excluded: { ...excluded, [i]: !e.target.checked } })}
                          />
                          <span>
                            {p.title}
                            <small className="mt-1 block text-subtle">
                              {p.start.slice(11)}–{p.end.slice(11)}
                            </small>
                          </span>
                        </span>
                      </label>
                    ]
                  : []
              )}
            </div>
          )
        })}
      </div>
      {!!node.proposals?.length && (
        <button disabled={disabled || !selected.length} className={cn(uiAction, 'mt-3')} onClick={() => onConfirm(selected)}>
          {t('ui.action.schedule')}
        </button>
      )}
    </div>
  )
}
function Mastery({ data }: { data: Extract<UiData, { type: 'mastery' }> }) {
  const { t } = useTranslation()
  // 薄弱前三项只从“薄弱 / 学习中”里挑，已掌握的不该出现在这里
  const weakest = data.notes
    .filter((n) => n.status === 'weak' || n.status === 'learning')
    .sort((a, b) => (a.recall ?? 0) - (b.recall ?? 0))
    .slice(0, 3)
  return (
    <div>
      <p className="mb-2 text-sm">{t('ui.due', { n: data.due })}</p>
      <div className="flex flex-wrap gap-1.5">
        {data.notes.map((note) => (
          <button
            key={note.id}
            className={cn(
              'rounded-md border px-2 py-1 text-2xs',
              note.status === 'weak'
                ? 'border-viz-4/40 bg-viz-4/10 text-viz-4'
                : note.status === 'solid'
                  ? 'border-viz-8/40 bg-viz-8/10 text-viz-8'
                  : note.status === 'learning'
                    ? 'border-viz-6/40 bg-viz-6/10 text-viz-6'
                    : 'border-border bg-sunken text-muted'
            )}
            onClick={() => useApp.getState().openNote(note.id)}
          >
            {note.title} · {t(`mastery.status.${note.status}`)}
          </button>
        ))}
      </div>
      <ol className="my-3 space-y-1 text-xs">
        {weakest.map((n) => (
          <li key={n.id}>
            <button className="text-accent" onClick={() => useApp.getState().openNote(n.id)}>
              {n.title}
            </button>
            {n.weakConcepts.length > 0 && <span className="ml-2 text-subtle">{n.weakConcepts.slice(0, 3).join('、')}</span>}
          </li>
        ))}
      </ol>
      <button className={uiAction} onClick={() => useApp.getState().setView('review')}>
        {t('ui.action.startReview')}
      </button>
    </div>
  )
}
