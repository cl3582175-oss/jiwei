import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Mic,
  Pause,
  Play,
  Square,
  Star,
  Check,
  ListTodo,
  Loader2,
  Sparkles,
  FileAudio,
  Trash2,
  Users,
  GraduationCap,
  Lightbulb,
  Info,
  Plus,
  AlertTriangle
} from 'lucide-react'
import { toast } from 'sonner'
import { fmtTime } from '@shared/context'
import { api, cn } from '@/lib/utils'
import { useSettings } from '@/lib/queries'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, Input, Tip } from '@/components/ui/primitives'
import { useRecording, startRecording, togglePause, endRecording, recordingElapsed } from './store'

export function useRecordings() {
  const qc = useQueryClient()
  useEffect(
    () =>
      window.jiweiEvents.on('recording:changed', () => {
        void qc.invalidateQueries({ queryKey: ['recordings'] })
      }),
    [qc]
  )
  return useQuery({ queryKey: ['recordings'], queryFn: () => api.recording.list(), refetchInterval: 1000 })
}
export function RecordingStart({ noteId = null }: { noteId?: string | null }) {
  const { t } = useTranslation(),
    { data: settings } = useSettings()
  const [scene, setScene] = useState<'meeting' | 'lecture' | 'thought'>(settings?.recordingScene ?? 'meeting')
  const [device, setDevice] = useState(''),
    [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [system, setSystem] = useState(false),
    [local, setLocal] = useState(scene === 'thought')
  const [participants, setParticipants] = useState<string[]>([]),
    [extra, setExtra] = useState(''),
    [name, setName] = useState('')
  const sceneChosen = useRef(false)
  useEffect(() => {
    if (!settings || sceneChosen.current) return
    sceneChosen.current = true
    setScene(settings.recordingScene ?? 'meeting')
    setLocal(settings.recordingScene === 'thought')
  }, [settings])
  const { data: people = [], refetch } = useQuery({ queryKey: ['people'], queryFn: () => api.people.list() })
  const busy = useRecording((s) => s.busy),
    error = useRecording((s) => s.error)
  useEffect(() => {
    void navigator.mediaDevices
      .enumerateDevices()
      .then((d) => setDevices(d.filter((x) => x.kind === 'audioinput')))
      .catch(() => {})
  }, [])
  return (
    <section className="@container space-y-4" data-testid="recording-start">
      <div className="grid gap-2 @min-[520px]:grid-cols-3">
        {(
          [
            ['meeting', Users],
            ['lecture', GraduationCap],
            ['thought', Lightbulb]
          ] as const
        ).map(([s, Icon]) => (
          <button
            key={s}
            type="button"
            aria-label={t(`recording.scene.${s}`)}
            aria-pressed={scene === s}
            onClick={() => {
              sceneChosen.current = true
              setScene(s)
              setLocal(s === 'thought')
            }}
            className={cn(
              'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
              scene === s ? 'border-accent bg-accent-soft' : 'border-border bg-surface hover:bg-surface-hover'
            )}
          >
            <Icon className={cn('mt-0.5 size-4 shrink-0', scene === s ? 'text-accent' : 'text-subtle')} />
            <span className="min-w-0">
              <span className={cn('block text-sm font-medium', scene === s ? 'text-accent' : 'text-fg')}>{t(`recording.scene.${s}`)}</span>
              <span className="mt-0.5 block text-2xs leading-snug text-muted">{t(`recording.sceneHint.${s}`)}</span>
            </span>
          </button>
        ))}
      </div>
      {scene === 'meeting' && (
        <p className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-fg">
          <Info className="size-3.5 shrink-0 text-warning" />
          {t('recording.consent')}
        </p>
      )}
      <label className="block space-y-1.5 text-xs text-muted">
        <span>{t('recording.sources')}</span>
        <select
          aria-label={t('recording.mic')}
          value={device}
          onChange={(e) => setDevice(e.target.value)}
          className="h-9 w-full rounded-md border border-border bg-surface px-2.5 text-sm text-fg"
        >
          <option value="">{t('recording.defaultDevice')}</option>
          {devices
            .filter((d) => d.deviceId)
            .map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || t('recording.device', { n: i + 1 })}
              </option>
            ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={system} onChange={(e) => setSystem(e.target.checked)} />
          {t('recording.system')}
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} />
          {t('recording.localOnly')}
        </label>
      </div>
      {scene !== 'thought' && (
        <div className="space-y-2">
          <p className="text-xs text-muted">{t('recording.participants')}</p>
          <div className="flex max-h-24 flex-wrap gap-2 overflow-y-auto">
            {people.map((p) => (
              <label
                className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:text-accent"
                key={p.id}
              >
                <input
                  type="checkbox"
                  checked={participants.includes(p.id)}
                  onChange={(e) => setParticipants(e.target.checked ? [...participants, p.id] : participants.filter((id) => id !== p.id))}
                />
                {p.name}
              </label>
            ))}
          </div>
          <div className="flex gap-1">
            <Input
              aria-label={t('recording.newPerson')}
              placeholder={t('recording.newPerson')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Button
              variant="outline"
              disabled={!name.trim()}
              onClick={() =>
                void api.people
                  .save({ name })
                  .then((p) => {
                    setParticipants([...participants, p.id])
                    setName('')
                    void refetch()
                  })
                  .catch((e) => toast.error(String(e)))
              }
            >
              <Plus />
              {t('recording.add')}
            </Button>
          </div>
        </div>
      )}
      <Input
        aria-label={t('recording.extraHotwords')}
        placeholder={t('recording.extraHotwords')}
        value={extra}
        onChange={(e) => setExtra(e.target.value)}
      />
      {error && (
        <div className="text-xs text-danger" role="alert">
          {error.startsWith('recording.') ? t(error) : error}
          {error.includes('micDenied') && (
            <Button variant="ghost" size="sm" onClick={() => void api.recording.openMicSettings()}>
              {t('recording.openSettings')}
            </Button>
          )}
        </div>
      )}
      <Button
        variant="primary"
        className="h-10 w-full px-5 @min-[520px]:w-auto"
        disabled={busy}
        onClick={() =>
          void startRecording({ scene, device, system, participants, extraHotwords: extra, localOnly: local, noteId }).catch(() => {})
        }
      >
        {busy ? <Loader2 className="animate-spin" /> : <Mic />}
        {t('recording.start')}
      </Button>
    </section>
  )
}
export function RecorderBar({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation(),
    { data: settings } = useSettings(),
    state = useRecording(),
    { data: rows = [] } = useRecordings()
  const r = rows.find((r) => r.id === state.current?.id) ?? state.current
  const [summary, setSummary] = useState(''),
    [summarizing, setSummarizing] = useState(false),
    [markerText, setMarkerText] = useState('')
  const { data: asr } = useQuery({ queryKey: ['asr'], queryFn: () => api.asr.status() })
  if (!r) return null
  const mark = (kind: 'star' | 'decision' | 'todo'): void => {
    void api.recording
      .mark(r.id, { t: recordingElapsed() / 1000, kind, text: markerText })
      .then(() => setMarkerText(''))
      .catch((e) => toast.error(String(e)))
  }
  const reason = r.localOnly ? 'localHint' : !settings?.ai.chat.model ? 'modelNeeded' : !r.preview.length ? 'previewNeeded' : null
  return (
    <section
      tabIndex={0}
      data-testid={compact ? 'recording-floating' : 'recorder'}
      className={cn(
        'rounded-xl border border-border bg-surface p-5 shadow-card outline-none',
        compact && 'mx-3 max-h-[35vh] overflow-y-auto p-3'
      )}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).matches('input,textarea')) return
        const kind = { '1': 'star', '2': 'decision', '3': 'todo' }[e.key] as 'star' | 'decision' | 'todo' | undefined
        if (kind) {
          e.preventDefault()
          mark(kind)
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className={cn('flex items-center gap-2.5 font-medium tabular-nums', compact ? 'text-md' : 'text-2xl')}>
          <span className="relative flex size-2.5">
            {state.current?.status === 'paused' ? null : (
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-danger opacity-60" />
            )}
            <span
              className={cn('relative inline-flex size-2.5 rounded-full', state.current?.status === 'paused' ? 'bg-subtle' : 'bg-danger')}
            />
          </span>
          {fmtTime(state.elapsed / 1000)}
        </span>
        <div className="flex min-w-28 flex-1 flex-col gap-1">
          {r.tracks.map((track) => (
            <div className="flex items-center gap-2 text-2xs text-muted" key={track}>
              <span className="w-12 shrink-0">{t(`recording.${track}`)}</span>
              <div
                role="meter"
                aria-label={t(`recording.${track}`)}
                aria-valuemin={0}
                aria-valuemax={1}
                aria-valuenow={state.levels[track] ?? 0}
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken"
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-100"
                  style={{ width: `${Math.round(Math.min(1, state.levels[track] ?? 0) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
        <Button size="sm" variant="ghost" disabled={state.busy} onClick={() => void togglePause().catch((e) => toast.error(String(e)))}>
          {state.current?.status === 'paused' ? <Play /> : <Pause />}
          {t(state.current?.status === 'paused' ? 'recording.resume' : 'recording.pause')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={state.busy}
          onClick={() =>
            void endRecording()
              .then((done) => {
                if (done?.sourceId) useApp.getState().openSource(done.sourceId)
              })
              .catch((e) => toast.error(String(e)))
          }
        >
          {state.busy ? <Loader2 className="animate-spin" /> : <Square />}
          {t('recording.finish')}
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-border pt-3">
        {(
          [
            ['star', Star],
            ['decision', Check],
            ['todo', ListTodo]
          ] as const
        ).map(([kind, Icon]) => (
          <Tip key={kind} label={t(`recording.marker.${kind}`)} side="bottom">
            <Button variant="ghost" size="sm" aria-label={t(`recording.marker.${kind}`)} onClick={() => mark(kind)}>
              <Icon />
              {!compact && t(`recording.marker.${kind}`)}
            </Button>
          </Tip>
        ))}
        <Input
          className="h-7 min-w-24 flex-1 text-xs"
          aria-label={t('recording.markerText')}
          placeholder={t('recording.markerText')}
          value={markerText}
          onChange={(e) => setMarkerText(e.target.value)}
        />
        <Button
          size="sm"
          variant="ghost"
          disabled={!!reason || summarizing}
          title={reason ? t(`recording.${reason}`) : undefined}
          onClick={() => {
            setSummarizing(true)
            void api.recording
              .summarize(r.id)
              .then(setSummary)
              .catch((e) => toast.error(String(e)))
              .finally(() => setSummarizing(false))
          }}
        >
          <Sparkles />
          {t('recording.recent')}
        </Button>
      </div>
      {(reason || state.notice) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {reason && <span className="rounded-full bg-sunken px-2 py-0.5 text-2xs text-muted">{t(`recording.${reason}`)}</span>}
          {state.notice && <span className="rounded-full bg-warning/10 px-2 py-0.5 text-2xs text-fg">{t(state.notice)}</span>}
        </div>
      )}
      {state.error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {state.error}
        </p>
      )}
      <div className="mt-3 rounded-lg bg-sunken/70 px-3 py-2.5" aria-label={t('recording.preview')}>
        <p className="mb-1 text-2xs font-medium tracking-wide text-subtle">{t('recording.live')}</p>
        <div className={cn('overflow-y-auto font-kai text-sm leading-relaxed', compact ? 'max-h-16' : 'max-h-40')}>
          {asr?.state !== 'ready' ? (
            <p className="text-muted">{t('recording.afterTranscript')}</p>
          ) : (
            r.preview.slice(-6).map((c, i, all) => (
              <p key={i} className={i === all.length - 1 ? 'text-fg' : 'text-muted'}>
                {c.text}
              </p>
            ))
          )}
        </div>
      </div>
      {summary && (
        <p className="mt-2 flex gap-2 rounded-lg border-l-2 border-accent bg-accent-soft/60 px-3 py-2 text-xs leading-relaxed">
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" />
          {summary}
        </p>
      )}
    </section>
  )
}
export function RecordingView() {
  const { t } = useTranslation(),
    { data: rows = [], refetch } = useRecordings(),
    current = useRecording((s) => s.current)
  const unfinished = rows.filter((r) => r.id !== current?.id && ['recording', 'paused', 'finalizing', 'failed'].includes(r.status))
  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-14 shrink-0 items-center gap-2 border-b border-border px-6">
        <Mic className="size-5 text-accent" />
        <h1 className="text-md font-medium">{t('recording.title')}</h1>
      </header>
      <div className="mx-auto w-full max-w-3xl flex-1 space-y-5 overflow-y-auto p-6">
        {unfinished.map((r) => (
          <section className="rounded-xl border border-warning/30 bg-warning/10 p-4" key={r.id} data-testid="recording-recovery">
            <p className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="size-4 text-warning" />
              {t('recording.recovery', { time: fmtTime(r.durationMs / 1000) })}
            </p>
            {r.error && <p className="text-xs text-danger">{r.error}</p>}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="primary"
                onClick={() =>
                  void api.recording
                    .finish(r.id)
                    .then((r) => {
                      void refetch()
                      if (r.sourceId) useApp.getState().openSource(r.sourceId)
                    })
                    .catch((e) => toast.error(String(e)))
                }
              >
                {t('recording.recoverFinish')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void api.recording.discard(r.id).then(() =>
                    toast(t('recording.discarded'), {
                      action: { label: t('recording.undo'), onClick: () => void api.recording.restore(r.id) }
                    })
                  )
                }
              >
                <Trash2 />
                {t('recording.discard')}
              </Button>
            </div>
          </section>
        ))}
        {current ? (
          <RecorderBar />
        ) : (
          <section className="rounded-xl border border-border bg-surface p-5">
            <h2 className="mb-4 font-serif text-lg font-semibold">{t('recording.startTitle')}</h2>
            <RecordingStart />
          </section>
        )}
        <div className="space-y-2">
          {rows
            .filter((r) => r.status === 'ready')
            .map((r) => (
              <Button
                variant="ghost"
                className="h-auto w-full justify-start gap-3 py-3"
                key={r.id}
                onClick={() => r.sourceId && useApp.getState().openSource(r.sourceId)}
              >
                <FileAudio />
                <span>
                  {t(`recording.scene.${r.scene}`)} · {new Date(r.startedAt).toLocaleString()}
                </span>
                <span className="ml-auto text-xs text-muted tabular-nums">{fmtTime(r.durationMs / 1000)}</span>
              </Button>
            ))}
        </div>
      </div>
    </div>
  )
}
export function RecordingDialog() {
  const { t } = useTranslation(),
    { opening, noteId } = useRecording()
  return (
    <Dialog open={opening} onOpenChange={(opening) => useRecording.setState({ opening })}>
      <DialogContent title={t('recording.startTitle')} className="max-h-[90vh] overflow-y-auto">
        <div className="mt-4">
          <RecordingStart noteId={noteId} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
