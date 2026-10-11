import { useEffect, useMemo, useState } from 'react'
import { useMoney } from '@/lib/money'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check, Copy, SlidersHorizontal, GraduationCap, Lightbulb, Loader2, Play, Plus, Save, Sparkles, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  lectureNoteItems,
  lensActionCommitted,
  lensItemCreatesRow,
  lensMarkdown,
  lensRowCue,
  sceneNeedsChoice,
  type EvidenceSentence,
  type Landing,
  type LensItem
} from '@shared/lens'
import type { Source } from '@shared/types'
import { fmtTime } from '@shared/context'
import { api, cn } from '@/lib/utils'
import { useSettings } from '@/lib/queries'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, Input } from '@/components/ui/primitives'
import { prompt } from '@/components/ui/confirm'
import { lensSelectClass, SeriesSelect } from './SeriesSelect'
import { lensTitle } from './LensSettings'
import { applyLensLanding } from './documents'

const mainLenses = [
  ['meeting', Users],
  ['lecture', GraduationCap],
  ['thought', Lightbulb]
] as const
const emptyIds: string[] = []

export function LensPanel({
  source,
  onEvidence,
  onClose
}: {
  source: Source
  onEvidence: (s: EvidenceSentence) => void
  onClose: () => void
}) {
  const money = useMoney()
  const { t, i18n } = useTranslation(),
    qc = useQueryClient(),
    { data: settings } = useSettings()
  const { data: lenses = [] } = useQuery({ queryKey: ['lenses'], queryFn: () => api.lenses.list() })
  const { data: recordings = [] } = useQuery({ queryKey: ['recordings'], queryFn: () => api.recording.list() })
  const recording = recordings.find((r) => r.sourceId === source.id)
  const { data: history = [], refetch: refreshHistory } = useQuery({
    queryKey: ['lens-history', source.id],
    queryFn: () => api.lenses.history(source.id),
    refetchInterval: 1000
  })
  const { data: people = [] } = useQuery({ queryKey: ['people'], queryFn: () => api.people.list() })
  const { data: notes = [] } = useQuery({ queryKey: ['notes', 'lens-destination'], queryFn: () => api.notes.list({}) })
  const { data: estimate } = useQuery({ queryKey: ['lens-estimate', source.id], queryFn: () => api.lenses.estimate(source.id) })
  const { data: jobs = [] } = useQuery({ queryKey: ['jobs'], queryFn: () => api.jobs.list(), refetchInterval: 1000 })
  const [lensId, setLensId] = useState(''),
    [versionId, setVersionId] = useState(''),
    [instruction, setInstruction] = useState(''),
    [topic, setTopic] = useState(''),
    [personId, setPersonId] = useState('')
  const [edited, setEdited] = useState<Record<string, LensItem>>({}),
    [accepted, setAccepted] = useState<Set<string>>(new Set()),
    [noteId, setNoteId] = useState<string | null | undefined>(undefined)
  const [configOpen, setConfigOpen] = useState(false)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saving, setSaving] = useState(false),
    [title, setTitle] = useState(''),
    [lastLanding, setLastLanding] = useState<Landing | null>(null)
  const configured = !!settings?.ai.chat.providerId && !!settings.ai.chat.model
  const { data: guess, error: guessError } = useQuery({
    queryKey: ['lens-guess', source.id],
    queryFn: () => api.lenses.guess(source.id),
    enabled: configured && !source.aiExcluded && (!recording || recording.scene === 'unspecified'),
    retry: false
  })
  const scene = recording?.scene ?? 'unspecified',
    prediction = recording?.sceneGuess ?? guess ?? null
  const needsChoice = sceneNeedsChoice(scene, prediction)
  const current = history.find((d) => d.id === versionId) ?? history[0]
  const lens = lenses.find((l) => l.id === lensId)
  const { data: duplicateIds = emptyIds } = useQuery({
    queryKey: ['lens-duplicates', current?.id],
    queryFn: () => api.lenses.duplicates(current!.id),
    enabled: !!current?.result
  })
  const { data: landings = [], refetch: refreshLandings } = useQuery({
    queryKey: ['lens-landings', current?.id],
    queryFn: () => api.lenses.landings(current!.id),
    enabled: !!current?.result,
    refetchInterval: 5000
  })
  const landedIds = useMemo(
    () => new Set(landings.filter((l) => l.status === 'applied' || l.status === 'undoing').flatMap((l) => l.items.map((i) => i.id))),
    [landings]
  )
  useEffect(() => {
    if (!lensId && (scene !== 'unspecified' || prediction)) setLensId(`lens-${scene === 'unspecified' ? prediction!.scene : scene}`)
  }, [lensId, scene, prediction])
  useEffect(() => {
    if (noteId === undefined && recording) setNoteId(recording.noteId)
  }, [recording, noteId])
  useEffect(() => {
    setEdited(Object.fromEntries((current?.result?.items ?? []).map((i) => [i.id, { ...i }])))
    setAccepted(new Set(current?.result?.items.filter((i) => lensActionCommitted(i, current.result!.sentences)).map((i) => i.id)))
    setLastLanding(null)
    setError('')
  }, [current?.id, current?.result])
  useEffect(() => {
    setAccepted((ids) => new Set([...ids].filter((id) => !duplicateIds.includes(id))))
  }, [duplicateIds])
  const selected = (current?.result?.items ?? []).filter((i) => accepted.has(i.id) && !landedIds.has(i.id)).map((i) => edited[i.id] ?? i)
  const groups = useMemo(() => {
    const out = new Map<LensItem['category'], LensItem[]>()
    for (const item of current?.result?.items ?? []) out.set(item.category, [...(out.get(item.category) ?? []), item])
    return out
  }, [current?.result])
  const active = current && ['queued', 'running'].includes(current.status)
  // 有结果后把视角与系列设置收成一行，把空间留给审阅；需要时展开
  const showConfig = configOpen || !current?.result
  const job = jobs.find((j) => j.id === current?.jobId)
  const canRun =
    configured &&
    !source.aiExcluded &&
    !needsChoice &&
    !!lensId &&
    (lensId !== 'custom' || !!instruction.trim()) &&
    (lensId !== 'lens-topic' || !!topic.trim()) &&
    (lensId !== 'lens-person' || !!personId)
  const change = (id: string, patch: Partial<LensItem>): void => setEdited((old) => ({ ...old, [id]: { ...old[id], ...patch } }))
  const toggle = (id: string, value: boolean): void =>
    setAccepted((old) => {
      const ids = new Set(old)
      if (value) ids.add(id)
      else ids.delete(id)
      return ids
    })
  const execute = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (e) {
      setError(String(e))
      toast.error(String(e))
    } finally {
      setBusy(false)
    }
  }
  const run = async (offPeak = false): Promise<void> => {
    const d = await api.lenses.run({
      sourceId: source.id,
      lens: lensId,
      params: { ...(lensId === 'custom' ? { instruction } : {}), ...(topic ? { topic } : {}), ...(personId ? { personId } : {}) },
      offPeak
    })
    await refreshHistory()
    setVersionId(d.id)
  }
  const land = async (): Promise<void> => {
    if (!current) return
    const landing = await api.lenses.prepare({
      derivationId: current.id,
      items: selected.map(({ id, title, body, cue, ownerPersonId, ownerName, dueDate, completeAction }) => ({
        id,
        title,
        body,
        cue,
        ownerPersonId,
        ownerName,
        dueDate,
        completeAction: completeAction ?? false
      })),
      noteId: noteId ?? null,
      ...(personId ? { personId } : {})
    })
    await applyLensLanding(landing)
    const rows = await refreshLandings()
    setLastLanding(rows.data?.find((l) => l.id === landing.id) ?? null)
    for (const key of ['notes', 'actions', 'insights', 'review', 'concepts', 'series-actions', 'person-page', 'series-page'])
      void qc.invalidateQueries({ queryKey: [key] })
  }
  const undo = async (landing: Landing): Promise<void> => {
    await applyLensLanding(await api.lenses.undo(landing.id), true)
    const rows = await refreshLandings()
    setLastLanding(rows.data?.find((l) => l.id === landing.id) ?? null)
  }
  const receipt = lastLanding ?? landings.find((l) => l.status === 'applied')
  const pending = landings.find((l) => l.status === 'pending')
  const restorePending = (): void => {
    if (!pending) return
    setEdited(Object.fromEntries(pending.items.map((i) => [i.id, { ...i }])))
    setAccepted(new Set(pending.items.map((i) => i.id)))
    setNoteId(pending.noteId)
    const person = pending.objects.find((o) => o.kind === 'person')
    if (person) setPersonId(person.id)
    setError('')
  }
  const rule = current?.landing ?? lens?.landing ?? 'append'
  const actionCount = ['meeting', 'lecture', 'thought', 'todos'].includes(rule) ? selected.filter((i) => i.category === 'action').length : 0
  const insightCount = rule === 'thought' ? selected.filter((i) => i.category === 'idea').length : 0
  const rowItems = (rule === 'lecture' ? lectureNoteItems(selected) : selected).filter((i) => lensItemCreatesRow(rule, i))
  const rowCount = rowItems.length
  const cardCount =
    noteId && notes.find((n) => n.id === noteId)?.reviewExcluded ? 0 : rowItems.filter((i) => lensRowCue(rule, i).trim().length >= 2).length
  const needsNote = !['todos', 'person'].includes(rule)
  const showDestination = needsNote && !!current?.result
  const dateBasis = (item: LensItem): string =>
    item.dueQuote
      ? t('lens.dueBasis', {
          quote: item.dueQuote,
          date: item.dueDate || t('lens.unresolvedDate'),
          weekday: item.dueDate ? new Date(`${item.dueDate}T12:00:00`).toLocaleDateString(i18n.language, { weekday: 'short' }) : ''
        })
      : ''
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col border-border bg-surface"
      data-testid="lens-panel"
      aria-label={t('lens.review')}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <h2 className="mr-auto text-sm font-medium">{t('lens.review')}</h2>
        <Button size="icon-sm" variant="ghost" aria-label={t('lens.close')} onClick={onClose}>
          <X />
        </Button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {showConfig && (
          <>
            <div className="grid grid-cols-3 gap-1.5">
              {mainLenses.map(([id, Icon]) => {
                const on = lensId === `lens-${id}`,
                  suggested = needsChoice && prediction?.scene === id
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={on}
                    className={cn(
                      'relative flex min-w-0 items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-medium transition-colors',
                      on ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface text-fg hover:bg-surface-hover'
                    )}
                    onClick={() =>
                      needsChoice
                        ? void execute(async () => {
                            await api.lenses.chooseScene(source.id, id)
                            await qc.invalidateQueries({ queryKey: ['recordings'] })
                            setLensId(`lens-${id}`)
                          })
                        : setLensId(`lens-${id}`)
                    }
                  >
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate">{t(`lens.names.${id}`)}</span>
                    {suggested && (
                      <span
                        className="absolute -top-2 right-1 rounded-full bg-accent px-1.5 text-[10px] leading-4 text-accent-fg"
                        aria-hidden
                      >
                        {t('lens.suggested')}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
            <div className="flex flex-wrap gap-2">
              <select
                className={lensSelectClass + ' flex-1'}
                aria-label={t('lens.more')}
                value={lensId && !mainLenses.some(([id]) => lensId === `lens-${id}`) && lensId !== 'custom' ? lensId : ''}
                onChange={(e) => e.target.value && setLensId(e.target.value)}
              >
                <option value="">{t('lens.more')}</option>
                {lenses
                  .filter((l) => !mainLenses.some(([id]) => l.id === `lens-${id}`))
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {lensTitle(l, t)}
                    </option>
                  ))}
              </select>
              <Button variant={lensId === 'custom' ? 'secondary' : 'ghost'} size="sm" onClick={() => setLensId('custom')}>
                {t('lens.custom')}
              </Button>
            </div>
            {lensId === 'custom' && (
              <textarea
                className="w-full rounded-lg border border-border bg-surface p-2 text-xs outline-none focus:border-accent"
                aria-label={t('lens.instruction')}
                placeholder={t('lens.instruction')}
                rows={3}
                maxLength={2000}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
            )}
            {lensId === 'lens-topic' && (
              <Input
                aria-label={t('lens.topic')}
                placeholder={t('lens.topic')}
                value={topic}
                maxLength={500}
                onChange={(e) => setTopic(e.target.value)}
              />
            )}
            {lensId === 'lens-person' && (
              <select
                className={lensSelectClass + ' w-full'}
                aria-label={t('lens.person')}
                value={personId}
                onChange={(e) => setPersonId(e.target.value)}
              >
                <option value="">{t('lens.person')}</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            {needsChoice && (
              <div className="rounded-lg bg-sunken px-3 py-2 text-2xs leading-relaxed text-muted">
                <p>{t('lens.chooseScene')}</p>
                {prediction && (
                  <p className="mt-0.5">
                    {t('lens.guess', {
                      scene: t(`recording.scene.${prediction.scene}`),
                      confidence: Math.round(prediction.confidence * 100),
                      reason: prediction.reason
                    })}
                  </p>
                )}
              </div>
            )}
            <SeriesSelect
              value={recording?.seriesId ?? null}
              scene={scene}
              onChange={(id) =>
                void execute(async () => {
                  await api.series.set(source.id, id)
                  await qc.invalidateQueries({ queryKey: ['recordings'] })
                })
              }
            />
          </>
        )}
        {(source.aiExcluded || !configured) && (
          <p className="text-xs text-muted" data-testid="lens-unavailable">
            {t(source.aiExcluded ? 'lens.local' : 'lens.model')}
          </p>
        )}
        {guessError && (
          <p role="alert" className="text-xs text-danger">
            {String(guessError)}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={current?.result ? 'outline' : 'primary'}
            size="sm"
            disabled={!canRun || busy || !!active}
            onClick={() => void execute(() => run())}
          >
            {busy || active ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {t('lens.run')}
          </Button>
          {estimate?.offPeak && (
            <Button variant="ghost" size="sm" disabled={!canRun || busy || !!active} onClick={() => void execute(() => run(true))}>
              {t('lens.offPeak')}
            </Button>
          )}
          {!!current?.result && (
            <Button variant="ghost" size="sm" className="ml-auto" aria-expanded={showConfig} onClick={() => setConfigOpen(!configOpen)}>
              <SlidersHorizontal />
              {t(showConfig ? 'lens.hideOptions' : 'lens.changeLens')}
            </Button>
          )}
        </div>
        {estimate?.offPeak && (
          <p className="text-2xs text-muted">
            {t('lens.estimate', {
              cost: estimate.cost === null ? t('lens.unknownCost') : money.format(estimate.cost),
              time: new Date(estimate.runAfter).toLocaleString(i18n.language)
            })}
          </p>
        )}
        {!!history.length && (
          <label className="flex flex-col gap-1 text-xs text-muted">
            {t('lens.history')}
            <select
              className={lensSelectClass}
              aria-label={t('lens.history')}
              value={current?.id ?? ''}
              onChange={(e) => setVersionId(e.target.value)}
            >
              {history.map((d) => (
                <option key={d.id} value={d.id}>
                  {new Date(d.createdAt).toLocaleString(i18n.language)} · {d.lensTitle} · {d.model} · {t(`lens.status.${d.status}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        {active && (
          <div className="flex flex-wrap items-center gap-2 text-xs" role="status">
            <Loader2 className="size-4 animate-spin" />
            {current.status === 'running' ? t('lens.loading', { progress: Math.round((job?.progress ?? 0) * 100) }) : t('lens.queued')}
            {current.runAfter > Date.now() && new Date(current.runAfter).toLocaleString(i18n.language)}
            <Button variant="ghost" size="sm" onClick={() => current.jobId && void execute(() => api.jobs.cancel(current.jobId!))}>
              {t('lens.cancel')}
            </Button>
          </div>
        )}
        {current?.status === 'stale' && (
          <p className="rounded-lg bg-warning/10 p-3 text-xs" role="status">
            {t('lens.stale')}
          </p>
        )}
        {current?.status === 'failed' && (
          <p role="alert" className="text-xs text-danger">
            {current.stats?.error ?? t('lens.status.failed')}
          </p>
        )}
        {!current && <p className="py-5 text-center text-xs leading-relaxed text-muted">{t('lens.empty')}</p>}
        {pending && (
          <div className="rounded-lg border border-border p-3 text-xs" role="status">
            <p>{t('lens.pendingReview')}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={restorePending}>
              {t('lens.restorePending')}
            </Button>
          </div>
        )}
        {[...groups].map(([category, items]) => (
          <section className="space-y-2" key={category}>
            <h3 className="flex items-center gap-2 text-2xs font-medium tracking-wide text-subtle">
              {t(`lens.category.${category}`)}
              <span className="rounded-full bg-sunken px-1.5 tabular-nums">{items.length}</span>
            </h3>
            {items.map((original) => {
              const item = edited[original.id] ?? original,
                checked = accepted.has(item.id),
                landed = landedIds.has(item.id),
                action = item.category === 'action' && ['meeting', 'lecture', 'thought', 'todos'].includes(rule)
              return (
                <article
                  key={item.id}
                  className={cn(
                    'rounded-xl border border-border bg-surface p-2.5 shadow-card transition-opacity',
                    !checked && !landed && 'opacity-55 shadow-none',
                    landed && 'border-accent/30 bg-accent-soft/20 shadow-none'
                  )}
                  data-testid="lens-item"
                >
                  <div className="mb-2 flex items-start gap-2">
                    <input
                      type="checkbox"
                      aria-label={t('lens.selected')}
                      checked={checked && !landed}
                      disabled={landed || current?.status !== 'ready'}
                      onChange={(e) => toggle(item.id, e.target.checked)}
                      className="mt-1"
                    />
                    <strong className={cn('min-w-0 flex-1 text-xs leading-relaxed', !checked && !landed && 'text-muted line-through')}>
                      {item.title}
                    </strong>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t(checked ? 'lens.deleteItem' : 'lens.restore')}
                      disabled={landed}
                      onClick={() => toggle(item.id, !checked)}
                    >
                      <X />
                    </Button>
                  </div>
                  {!landed && !lensActionCommitted(original, current?.result?.sentences ?? []) && (
                    <p className="mb-2 text-2xs text-warning">{t('lens.maybeAdvice')}</p>
                  )}
                  {duplicateIds.includes(item.id) && !landed && <p className="mb-2 text-2xs text-warning">{t('lens.duplicate')}</p>}
                  {landed && (
                    <p className="mb-2 flex items-center gap-1 text-2xs font-medium text-accent">
                      <Check className="size-3" />
                      {t('lens.landed')}
                    </p>
                  )}
                  {(rule === 'lecture' || rule === 'quiz') && !action && (
                    <Input
                      className="mb-2 h-8 text-xs"
                      aria-label={t('lens.cue')}
                      value={lensRowCue(rule, item)}
                      onChange={(e) => change(item.id, { cue: e.target.value })}
                      disabled={landed}
                    />
                  )}
                  <textarea
                    className={cn(
                      'w-full resize-none rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs leading-relaxed outline-none [field-sizing:content] hover:border-border focus:border-accent focus:bg-surface',
                      !checked && !landed && 'text-muted line-through'
                    )}
                    rows={1}
                    aria-label={t('lens.body')}
                    value={item.body}
                    maxLength={8000}
                    disabled={landed}
                    onChange={(e) => change(item.id, { body: e.target.value })}
                  />
                  {item.quote && <blockquote className="my-2 border-l-2 border-accent/40 pl-2 text-xs text-muted">{item.quote}</blockquote>}
                  {action && (
                    <div className="mt-2 space-y-2">
                      <div className="flex flex-wrap gap-1.5">
                        <select
                          className={lensSelectClass + ' rounded-full'}
                          aria-label={t('lens.owner')}
                          value={item.ownerPersonId ?? ''}
                          disabled={landed}
                          onChange={(e) =>
                            change(item.id, {
                              ownerPersonId: e.target.value || null,
                              ownerName: people.find((p) => p.id === e.target.value)?.name ?? item.ownerName
                            })
                          }
                        >
                          <option value="">{item.ownerName || t('lens.owner')}</option>
                          {people.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={landed}
                          onClick={() =>
                            void execute(async () => {
                              const name = await prompt({ title: t('recording.newPerson') })
                              if (name?.trim()) {
                                const p = await api.people.save({ name })
                                await qc.invalidateQueries({ queryKey: ['people'] })
                                change(item.id, { ownerPersonId: p.id, ownerName: p.name })
                              }
                            })
                          }
                        >
                          <Plus />
                          {t('recording.add')}
                        </Button>
                        <input
                          className={lensSelectClass + ' rounded-full'}
                          type="date"
                          aria-label={t('lens.due')}
                          value={item.dueDate ?? ''}
                          disabled={landed}
                          onChange={(e) => change(item.id, { dueDate: e.target.value || null })}
                        />
                      </div>
                      {!item.ownerPersonId && (
                        <Input
                          className="h-8 text-xs"
                          aria-label={t('lens.ownerName')}
                          value={item.ownerName ?? ''}
                          maxLength={100}
                          disabled={landed}
                          onChange={(e) => change(item.id, { ownerName: e.target.value })}
                        />
                      )}
                      {item.dueQuote && <p className="text-2xs text-muted">{dateBasis(item)}</p>}
                    </div>
                  )}
                  {category === 'progress' && (
                    <label className="my-2 flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        aria-label={t('lens.progressDone')}
                        checked={item.completeAction ?? false}
                        disabled={landed || !checked || current?.status !== 'ready'}
                        onChange={(e) => change(item.id, { completeAction: e.target.checked })}
                      />
                      {t('lens.progressDone')}
                    </label>
                  )}
                  {category === 'link' && item.noteId && (
                    <Button variant="ghost" size="sm" onClick={() => useApp.getState().openNote(item.noteId!)}>
                      {t(item.relation === 'contradicts' ? 'lens.contradicts' : 'lens.similar')} · {item.title}
                    </Button>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {item.evidence
                      .map((ref) => current?.result?.sentences.find((s) => s.ref === ref))
                      .filter((s): s is EvidenceSentence => !!s)
                      .map((s) => (
                        <Button
                          key={s.ref}
                          variant="outline"
                          size="sm"
                          className="h-6 rounded-full px-2 text-2xs"
                          data-testid="lens-evidence"
                          title={s.text}
                          onClick={() => onEvidence(s)}
                        >
                          <Play className="size-2.5" />
                          {fmtTime(s.start)}
                        </Button>
                      ))}
                  </div>
                </article>
              )
            })}
          </section>
        ))}
        {!!current?.stats?.dropped.length && (
          <details className="rounded-lg bg-sunken p-3 text-xs" data-testid="lens-dropped">
            <summary>{t('lens.dropped', { count: current.stats.dropped.length })}</summary>
            {current.stats.dropped.map((d, i) => (
              <p key={i} className="mt-2 break-words text-muted">
                {d.title} · {t(`lens.reason.${d.reason}`)}
                {d.field ? ` (${d.field})` : ''}
              </p>
            ))}
          </details>
        )}
        {current?.lens === 'custom' && current.result && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSaving(true)
              setTitle('')
            }}
          >
            <Save />
            {t('lens.save')}
          </Button>
        )}
        {showDestination && (
          <label className="flex flex-col gap-1 text-xs text-muted">
            {t('lens.destination')}
            <select
              aria-label={t('lens.destination')}
              className={lensSelectClass}
              value={noteId ?? ''}
              onChange={(e) => setNoteId(e.target.value || null)}
            >
              <option value="">{t('lens.newNote')}</option>
              {notes
                .filter((n) => n.kind === 'cornell' && !n.aiExcluded)
                .map((n) => (
                  <option value={n.id} key={n.id}>
                    {n.title}
                  </option>
                ))}
            </select>
          </label>
        )}
        {error && (
          <p className="break-words text-xs text-danger" role="alert">
            {error}
          </p>
        )}
        {receipt && (
          <section className="space-y-2 rounded-xl border border-accent/30 bg-accent-soft/30 p-3 text-xs" data-testid="lens-receipt">
            <p>{t(receipt.status === 'undone' ? 'lens.undone' : 'lens.landedSummary', { count: receipt.items.length })}</p>
            {receipt.status === 'applied' && (
              <>
                <div className="flex flex-wrap gap-1">
                  {receipt.noteId && (
                    <Button size="sm" variant="ghost" onClick={() => useApp.getState().openNote(receipt.noteId!)}>
                      {t('lens.openNote')}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => useApp.getState().setView('reflect')}>
                    {t('lens.viewActions')}
                  </Button>
                  <Button size="sm" variant="outline" disabled={!receipt.canUndo || busy} onClick={() => void execute(() => undo(receipt))}>
                    {t('lens.undo')}
                  </Button>
                </div>
                <p className="text-2xs text-muted">{t('lens.undoHint')}</p>
              </>
            )}
          </section>
        )}
      </div>
      {!!current?.result && (
        <footer className="shrink-0 space-y-2 border-t border-border bg-surface px-3 py-2.5" data-testid="lens-footer">
          <p className="text-2xs leading-relaxed text-muted">
            {t('lens.preview', {
              notes: needsNote && selected.length > actionCount + insightCount ? 1 : 0,
              rows: rule === 'append' ? 0 : rowCount,
              actions: actionCount,
              cards: cardCount,
              insights: insightCount
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={
                source.aiExcluded ||
                busy ||
                current?.status !== 'ready' ||
                !selected.length ||
                selected.some((i) => !i.body.trim()) ||
                (rule === 'person' && !personId)
              }
              onClick={() => void execute(land)}
            >
              {busy && <Loader2 className="animate-spin" />}
              {t('lens.land')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!current?.result || !accepted.size}
              onClick={() =>
                void execute(async () => {
                  await navigator.clipboard.writeText(
                    lensMarkdown(
                      current!.result!.items.filter((i) => accepted.has(i.id)).map((i) => edited[i.id] ?? i),
                      current!.result!.sentences,
                      source.id
                    )
                  )
                  toast(t('lens.copied'))
                })
              }
            >
              <Copy />
              {t('lens.copy')}
            </Button>
          </div>
        </footer>
      )}
      <Dialog open={saving} onOpenChange={setSaving}>
        <DialogContent title={t('lens.save')}>
          <div className="mt-4 space-y-3">
            <Input aria-label={t('lens.name')} value={title} maxLength={40} onChange={(e) => setTitle(e.target.value)} />
            <Button
              variant="primary"
              disabled={!title.trim() || busy}
              onClick={() =>
                void execute(async () => {
                  await api.lenses.save({ title, instruction: current?.params.instruction ?? instruction })
                  await qc.invalidateQueries({ queryKey: ['lenses'] })
                  setSaving(false)
                })
              }
            >
              {t('common.save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
