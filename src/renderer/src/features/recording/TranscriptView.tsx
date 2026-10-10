import { useEffect, useMemo, useState } from 'react'
import { openPersonPage } from '../lenses/pages'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Search, ChevronUp, ChevronDown, Play, UserRound, Download, CircleHelp, Wand2, Lock } from 'lucide-react'
import type { Conversation, Segment, Source } from '@shared/types'
import { elementRect, type Rect } from '../assist/store'
import { speakerBody, transcriptTime, type RecordingSpeaker } from '@shared/recording'
import { fmtTime } from '@shared/context'
import { api, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, Input, Menu, MenuContent, MenuItem, MenuTrigger, Tip } from '@/components/ui/primitives'
import { confirm } from '@/components/ui/confirm'

const speakerName = (s: Segment, t: (key: string, opts?: Record<string, unknown>) => string): string =>
  (s.locator.personId ? /^［([^］]+)］/.exec(s.text)?.[1] : null) ??
  t('recording.speaker', { n: Number(String(s.locator.speaker ?? 'S01').slice(1)) })
function PersonChoice({
  sourceId,
  speaker,
  segmentId,
  close
}: {
  sourceId: string
  speaker: RecordingSpeaker
  segmentId?: string
  close: () => void
}) {
  const { t } = useTranslation(),
    qc = useQueryClient(),
    [search, setSearch] = useState(''),
    [name, setName] = useState(''),
    [scope, setScope] = useState(segmentId ? 'sentence' : 'all')
  const { data: people = [] } = useQuery({ queryKey: ['people'], queryFn: () => api.people.list() }),
    { data: speakers = [] } = useQuery({ queryKey: ['speakers', sourceId], queryFn: () => api.recording.speakers(sourceId) })
  const choose = async (personId: string | null, label = speaker.label): Promise<void> => {
    await api.recording.confirm({ sourceId, label, personId, ...(scope === 'sentence' && segmentId ? { segmentId } : {}) })
    void qc.invalidateQueries({ queryKey: ['speakers', sourceId] })
    void qc.invalidateQueries({ queryKey: ['people'] })
    close()
  }
  const me = async (): Promise<void> => {
    const p = people.find((p) => p.isMe) ?? (await api.people.save({ name: t('recording.me'), isMe: true }))
    await choose(p.id)
  }
  return (
    <div className="mt-3 space-y-3" data-testid="speaker-choices">
      {speaker.personId && (
        <Button
          variant="ghost"
          className="w-full justify-start"
          onClick={() => {
            close()
            openPersonPage(speaker.personId!)
          }}
        >
          {t('personPage.view')}
        </Button>
      )}
      {segmentId && (
        <div className="flex flex-wrap gap-2">
          {(['sentence', 'all'] as const).map((s) => (
            <Button key={s} variant={scope === s ? 'secondary' : 'ghost'} aria-pressed={scope === s} size="sm" onClick={() => setScope(s)}>
              {t(`recording.scope.${s}`)}
            </Button>
          ))}
        </div>
      )}
      <Button variant="ghost" className="w-full justify-start" onClick={() => void me().catch((e) => toast.error(String(e)))}>
        <UserRound />
        {t('recording.thisIsMe')}
      </Button>
      {speaker.maybeMe && <p className="text-xs text-muted">{t('recording.maybeMe')}</p>}
      <Input
        aria-label={t('recording.searchPeople')}
        placeholder={t('recording.searchPeople')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="max-h-36 overflow-y-auto">
        {people
          .filter((p) => `${p.name} ${p.note}`.includes(search))
          .map((p) => (
            <Button
              key={p.id}
              variant="ghost"
              className="h-auto w-full justify-start py-2 text-left"
              onClick={() => void choose(p.id).catch((e) => toast.error(String(e)))}
            >
              <span>
                {p.name}
                <span className="ml-2 text-2xs text-subtle">{p.note}</span>
              </span>
            </Button>
          ))}
        {scope === 'sentence' &&
          speakers
            .filter((s) => s.label !== speaker.label)
            .map((s) => (
              <Button
                variant="ghost"
                className="w-full justify-start"
                key={s.label}
                onClick={() => void choose(s.personId, s.label).catch((e) => toast.error(String(e)))}
              >
                {s.name ?? t('recording.speaker', { n: Number(s.label.slice(1)) })}
              </Button>
            ))}
      </div>
      <div className="flex gap-2">
        <Input
          aria-label={t('recording.newPerson')}
          placeholder={t('recording.newPerson')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          variant="ghost"
          disabled={!name.trim()}
          onClick={() =>
            void api.people
              .save({ name })
              .then((p) => choose(p.id))
              .catch((e) => toast.error(String(e)))
          }
        >
          {t('recording.add')}
        </Button>
      </div>
      <Button variant="ghost" onClick={() => void choose(null).catch((e) => toast.error(String(e)))}>
        {t('recording.skip')}
      </Button>
    </div>
  )
}
function TranscriptEditor({ seg, done }: { seg: Segment; done: () => void }) {
  const { t } = useTranslation(),
    [text, setText] = useState(speakerBody(seg.text))
  const save = async (): Promise<void> => {
    if (text.trim() && text !== speakerBody(seg.text)) await api.segments.update(seg.id, text)
    done()
  }
  return (
    <textarea
      autoFocus
      aria-label={t('media.editLine')}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          done()
        } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          void save().catch((e) => toast.error(String(e)))
        }
      }}
      className="min-h-16 w-full rounded-lg border border-accent bg-surface p-2 outline-none"
    />
  )
}
export function TranscriptView({
  source,
  segments,
  time,
  seek,
  threads,
  onThread,
  onStructureChange,
  highlightedId
}: {
  source: Source
  segments: Segment[]
  time: number
  seek: (t: number, play?: boolean, until?: number) => void
  threads: Conversation[]
  onThread: (c: Conversation, rect: Rect) => void
  onStructureChange: () => void
  highlightedId?: string
}) {
  const { t } = useTranslation(),
    qc = useQueryClient(),
    [editing, setEditing] = useState<string | null>(null),
    [choice, setChoice] = useState<{ speaker: RecordingSpeaker; segmentId?: string } | null>(null),
    [query, setQuery] = useState(''),
    [hit, setHit] = useState(0)
  const { data: speakers = [] } = useQuery({ queryKey: ['speakers', source.id], queryFn: () => api.recording.speakers(source.id) })
  const { data: voice } = useQuery({ queryKey: ['voiceprint'], queryFn: () => api.voiceprint.status() })
  const { data: moss } = useQuery({ queryKey: ['moss'], queryFn: () => api.moss.status() }),
    { data: jobs = [] } = useQuery({ queryKey: ['jobs'], queryFn: () => api.jobs.list() }),
    job = jobs.find(
      (j) => (j.key === `transcribe:${source.id}` || j.key === `moss:${source.id}`) && ['queued', 'running'].includes(j.status)
    ),
    failure = jobs.find((j) => (j.key === `transcribe:${source.id}` || j.key === `moss:${source.id}`) && j.status === 'failed')
  const { data: rows = [] } = useQuery({ queryKey: ['recordings'], queryFn: () => api.recording.list() }),
    recording = rows.find((r) => r.sourceId === source.id)
  useEffect(
    () =>
      window.jiweiEvents.on('segments:changed', ({ sourceId }) => {
        if (sourceId === source.id) void qc.invalidateQueries({ queryKey: ['speakers', source.id] })
      }),
    [qc, source.id]
  )
  useEffect(
    () =>
      window.jiweiEvents.on('people:changed', () => {
        void qc.invalidateQueries({ queryKey: ['speakers', source.id] })
        void qc.invalidateQueries({ queryKey: ['people'] })
      }),
    [qc, source.id]
  )
  useEffect(onStructureChange, [query, editing, onStructureChange])
  const matches = useMemo(
    () => (query ? segments.filter((s) => speakerBody(s.text).toLocaleLowerCase().includes(query.toLocaleLowerCase())) : []),
    [segments, query]
  )
  const jump = (delta: number): void => {
    if (!matches.length) return
    const i = (hit + delta + matches.length) % matches.length
    setHit(i)
    const el = document.querySelector(`[data-segment="${matches[i].id}"]`)
    el?.scrollIntoView({ block: 'center' })
    const tm = transcriptTime(matches[i].locator)
    if (tm) seek(tm[0])
  }
  const groups = useMemo(() => {
    const out: Segment[][] = []
    for (const s of segments) {
      const last = out.at(-1)
      if (last && last[0].locator.speaker === s.locator.speaker) last.push(s)
      else out.push([s])
    }
    return out
  }, [segments])
  const refine = async (): Promise<void> => {
    const edited = segments.some((s) => s.locator.edited)
    if (
      edited &&
      !(await confirm({ title: t('recording.overwrite'), description: t('recording.overwriteHint'), confirmText: t('course.refine') }))
    )
      return
    if (moss?.state === 'ready') await api.moss.refine(source.id, edited)
    else await api.asr.transcribe(source.id, edited)
  }
  return (
    <div className="pb-4" data-testid="dialogue-transcript">
      <div className="space-y-2 border-b border-border px-3 py-2.5" data-testid="transcript-tools">
        <div className="flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle" />
            <Input
              className="h-8 w-full pl-8 text-xs"
              aria-label={t('recording.searchTranscript')}
              placeholder={t('recording.searchTranscript')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setHit(0)
              }}
            />
          </div>
          <Button size="icon-sm" variant="ghost" aria-label={t('recording.previous')} disabled={!matches.length} onClick={() => jump(-1)}>
            <ChevronUp />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={t('recording.next')} disabled={!matches.length} onClick={() => jump(1)}>
            <ChevronDown />
          </Button>
          {query && <span className="text-xs text-muted">{matches.length}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={!source.assetUrl || !!job || !moss}
            title={!source.assetUrl ? t('recording.audioRemoved') : undefined}
            onClick={() => void refine().catch((e) => toast.error(String(e)))}
          >
            <Wand2 />
            {t(moss?.state === 'ready' ? 'course.refine' : 'media.transcribe')}
          </Button>
          <Menu>
            <MenuTrigger asChild>
              <Button size="sm" variant="ghost">
                <Download />
                {t('recording.export')}
              </Button>
            </MenuTrigger>
            <MenuContent>
              {(['md', 'srt', 'txt'] as const).map((f) => (
                <MenuItem key={f} onSelect={() => void api.recording.export(source.id, f).catch((e) => toast.error(String(e)))}>
                  {t(`recording.format.${f}`)}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          {source.kind === 'recording' && (
            <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={source.aiExcluded}
                onChange={(e) =>
                  void api.sources
                    .update(source.id, { aiExcluded: e.target.checked })
                    .then(() => qc.invalidateQueries({ queryKey: ['source', source.id] }))
                }
              />
              <Lock className="size-3" />
              {t('recording.localOnly')}
            </label>
          )}
        </div>
      </div>
      {segments.some((s) => s.locator.preview) && <p className="px-4 py-2 text-xs text-muted">{t('recording.previewTranscript')}</p>}
      {job && (
        <p className="px-4 py-2 text-xs text-muted" role="status">
          {t('media.transcribing', { p: Math.round(job.progress * 100) })}
        </p>
      )}
      {!job && failure && (
        <p className="px-4 py-2 text-xs text-danger" role="alert">
          {failure.error}
        </p>
      )}
      {voice?.state !== 'ready' && <p className="px-4 pt-2 text-2xs leading-relaxed text-subtle">{t('recording.voiceHint')}</p>}
      {!job && !segments.some((s) => s.locator.preview) && !!speakers.length && speakers.every((s) => s.personId || s.skipped) && (
        <p className="px-4 pt-2 text-2xs text-subtle">
          {t('lens.readyHint', {
            lens: t(`lens.names.${recording?.scene === 'lecture' ? 'lecture' : recording?.scene === 'thought' ? 'thought' : 'meeting'}`)
          })}
        </p>
      )}
      {speakers
        .filter((s) => !s.personId && !s.skipped)
        .map((s) => {
          const meButton = (primary: boolean) => (
            <Button
              size="sm"
              variant={primary ? 'primary' : 'outline'}
              onClick={() =>
                void (async () => {
                  const p =
                    (await api.people.list()).find((p) => p.isMe) ?? (await api.people.save({ name: t('recording.me'), isMe: true }))
                  await api.recording.confirm({ sourceId: source.id, label: s.label, personId: p.id })
                })().catch((e) => toast.error(String(e)))
              }
            >
              <UserRound />
              {t('recording.thisIsMe')}
            </Button>
          )
          return (
            <section
              key={s.label}
              data-testid="speaker-card"
              className="mx-3 mt-3 rounded-xl border border-border bg-surface p-3 shadow-card"
            >
              <div className="flex items-center gap-2.5">
                <span className={`speaker-avatar speaker-color-${Number(s.label.slice(1)) % 4}`} aria-hidden>
                  {Number(s.label.slice(1))}
                </span>
                <span className="min-w-0 flex-1 text-sm font-medium">{t('recording.who', { n: Number(s.label.slice(1)) })}</span>
              </div>
              {s.maybeMe && <p className="mt-1.5 pl-9 text-2xs leading-relaxed text-muted">{t('recording.maybeMe')}</p>}
              <div className="mt-1 pl-7">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!source.assetUrl}
                  title={!source.assetUrl ? t('recording.audioRemoved') : undefined}
                  onClick={() => seek(s.sampleStart, true, s.sampleEnd)}
                >
                  <Play />
                  {t('recording.sample')}
                </Button>
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-9">
                {s.maybeMe && meButton(true)}
                <Button size="sm" variant={s.maybeMe ? 'outline' : 'primary'} onClick={() => setChoice({ speaker: s })}>
                  {t('recording.confirmPerson')}
                </Button>
                {!s.maybeMe && meButton(false)}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => void api.recording.confirm({ sourceId: source.id, label: s.label, personId: null })}
                >
                  {t('recording.skip')}
                </Button>
              </div>
            </section>
          )
        })}
      {!!recording?.markers.length && (
        <div className="flex flex-wrap gap-1.5 px-4 pt-3">
          {recording.markers.map((m, i) => (
            <Button
              key={i}
              size="sm"
              variant="outline"
              className="h-6 rounded-full px-2 text-2xs"
              disabled={!source.assetUrl}
              title={source.assetUrl ? m.text : t('recording.audioRemoved')}
              onClick={() => seek(m.t, true)}
            >
              {m.kind === 'star' ? '★' : m.kind === 'decision' ? '✓' : '☐'} {fmtTime(m.t)}
              {m.text && ` ${m.text}`}
            </Button>
          ))}
        </div>
      )}
      <article className="source-text transcript select-text" aria-label={t('media.transcript')}>
        {groups.map((group) => (
          <div
            key={group[0].id}
            className={`speaker-block speaker-color-${Number(String(group[0].locator.speaker ?? 'S01').slice(1)) % 4}`}
            data-speaker={String(group[0].locator.speaker ?? '')}
          >
            {group.map((s, j) => {
              const tm = transcriptTime(s.locator)
              if (!tm) return null
              const name = speakerName(s, t),
                body = speakerBody(s.text),
                speaker = speakers.find((p) => p.label === s.locator.speaker)
              const parts = query ? body.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig')) : [body]
              return (
                <p
                  key={s.id}
                  data-t0={tm[0]}
                  data-t1={tm[1]}
                  className={cn(
                    'transcript-line dialogue-line',
                    j === 0 && 'is-first',
                    time >= tm[0] && time < tm[1] && 'is-current',
                    highlightedId === s.id && 'bg-accent-soft ring-1 ring-inset ring-accent/30'
                  )}
                  data-evidence={highlightedId === s.id || undefined}
                  style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 48px' }}
                >
                  {threads.some((c) => c.anchor?.ownerId === s.id) && (
                    <span className="thread-marks">
                      {threads
                        .filter((c) => c.anchor?.ownerId === s.id)
                        .map((c) => (
                          <Button
                            key={c.id}
                            size="icon-sm"
                            variant="ghost"
                            className="thread-dot"
                            aria-label={c.title}
                            onMouseUp={(e) => e.stopPropagation()}
                            onClick={(e) => onThread(c, elementRect(e.currentTarget))}
                          />
                        ))}
                    </span>
                  )}
                  <span className="dialogue-meta">
                    <Button
                      size="sm"
                      variant="ghost"
                      className={`speaker-name speaker-color-${Number(String(s.locator.speaker ?? 'S01').slice(1)) % 4}`}
                      aria-label={t('recording.changeSpeaker', { name })}
                      onMouseUp={(e) => e.stopPropagation()}
                      onClick={() => speaker && setChoice({ speaker, segmentId: s.id })}
                    >
                      {name}
                    </Button>
                    {!!s.locator.uncertain && (
                      <Tip label={t('recording.uncertain')}>
                        <CircleHelp className="inline size-3 text-muted" />
                      </Tip>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="transcript-time"
                      disabled={!source.assetUrl}
                      title={!source.assetUrl ? t('recording.audioRemoved') : undefined}
                      onMouseUp={(e) => e.stopPropagation()}
                      onClick={() => seek(tm[0], true)}
                    >
                      {fmtTime(tm[0])}
                    </Button>
                  </span>
                  <span
                    data-segment={s.id}
                    data-t0={tm[0]}
                    data-t1={tm[1]}
                    className="transcript-body"
                    onDoubleClick={() => setEditing(s.id)}
                  >
                    {editing === s.id ? (
                      <TranscriptEditor seg={s} done={() => setEditing(null)} />
                    ) : (
                      parts.map((part, j) =>
                        query && part.toLocaleLowerCase() === query.toLocaleLowerCase() ? <mark key={j}>{part}</mark> : part
                      )
                    )}
                  </span>
                  {!!s.locator.edited && <span className="ml-1 text-2xs text-subtle">{t('recording.edited')}</span>}
                </p>
              )
            })}
          </div>
        ))}
      </article>
      <Dialog
        open={!!choice}
        onOpenChange={(open) => {
          if (!open) setChoice(null)
        }}
      >
        <DialogContent title={t('recording.confirmPerson')}>
          {choice && <PersonChoice sourceId={source.id} {...choice} close={() => setChoice(null)} />}
        </DialogContent>
      </Dialog>
    </div>
  )
}
