import { RecoveryCodeDialog } from '../recording/RecordingSecurity'
import { TranscriptView } from '../recording/TranscriptView'
import { LensPanel } from '../lenses/LensPanel'
import type { EvidenceSentence } from '@shared/lens'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CircleHelp, Scissors, Camera, Captions, FileUp, Loader2, X, Pencil, Sparkles } from 'lucide-react'
import { fmtTime, type Anchor } from '@shared/context'
import type { Conversation, Segment, Source } from '@shared/types'
import { api, cn, formatBytes } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { useAssist, elementRect, type Rect } from '../assist/store'
import { useSettings } from '@/lib/queries'
import { askInline } from '../assist/actions'
import { useSourceSelection } from './SourcePane'
import { useAnnotations } from '../annotate/store'
import { useTextHighlights } from '../annotate/textHighlights'

// 视频 / 音频：播放器 + 时间轴（就地提问标记、A–B 区间）+ 与播放同步的转写稿。
// “指”的方式：选中转写稿文字 / 「没听懂」（当前时刻前 30 秒）/ 标出 A–B 区间 / 「问这个画面」（截取当前帧）。

/** 本地转写需要下载的大小（引擎 + ffmpeg + 模型，按 macOS arm64 估算） */
const ASR_DOWNLOAD = 267_000_000

const segTime = (s: Segment): [number, number] | null => {
  const m = String((s.locator as { value?: unknown }).value ?? '').match(/t=([\d.]+)(?:,([\d.]+))?/)
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null
}

function useAsrStatus() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['asr'], queryFn: () => api.asr.status() })
  useEffect(() => window.jiweiEvents.on('asr:status', (s) => qc.setQueryData(['asr'], s)), [qc])
  return q.data
}

/** 某时间段内的转写稿 */
function rangeText(segs: Segment[], t0: number, t1: number): { text: string; ownerId: string | null } {
  const hit = segs.filter((s) => {
    const t = segTime(s)
    return t && t[1] >= t0 && t[0] <= t1
  })
  return {
    text: hit
      .map((s) => s.text)
      .join(' ')
      .slice(0, 4000),
    ownerId: hit[0]?.id ?? null
  }
}

/** 纠正转写错误：就地编辑一行（Enter 保存，Esc 取消） */
function LineEditor({ seg, onDone }: { seg: Segment; onDone: () => void }) {
  const { t } = useTranslation()
  const [text, setText] = useState(seg.text)
  const save = async (): Promise<void> => {
    if (text.trim() && text.trim() !== seg.text) await api.segments.update(seg.id, text).catch((e: unknown) => toast.error(String(e)))
    onDone()
  }
  return (
    <textarea
      autoFocus
      value={text}
      aria-label={t('media.editLine')}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => void save()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          void save()
        } else if (e.key === 'Escape') {
          e.stopPropagation()
          onDone()
        }
      }}
      className="block min-h-16 w-full resize-y rounded-lg border border-accent bg-surface px-2 py-1 text-[length:inherit] leading-[inherit] text-fg outline-none"
    />
  )
}

function TranscriptEmpty({ source }: { source: Source }) {
  const { t } = useTranslation()
  const asr = useAsrStatus()
  const { data: settings } = useSettings()
  const cloud = settings?.ai.transcription?.mode === 'cloud'
  const { data: jobs = [] } = useQuery({ queryKey: ['jobs'], queryFn: () => api.jobs.list() })
  const job = jobs.find((j) => j.key === `transcribe:${source.id}` && (j.status === 'queued' || j.status === 'running'))
  const failed = jobs.find((j) => j.key === `transcribe:${source.id}` && j.status === 'failed')
  const start = (): void => void api.asr.transcribe(source.id).catch((e: unknown) => toast.error(String(e)))
  const importSub = (): void => void api.asr.importSubtitles(source.id).catch((e: unknown) => toast.error(String(e)))
  if (job || asr?.state === 'downloading')
    return (
      <div className="flex flex-col items-center gap-3 px-8 py-10 text-center text-sm text-muted" role="status">
        <Loader2 className="size-5 animate-spin text-accent" />
        {asr?.state === 'downloading'
          ? t('media.downloading', { p: Math.round(asr.progress * 100), mirror: asr.mirror ?? '' })
          : t('media.transcribing', { p: Math.round((job?.progress ?? 0) * 100) })}
        <p className="max-w-[300px] text-2xs leading-relaxed text-subtle">{t('media.transcribingHint')}</p>
      </div>
    )
  return (
    <div className="flex flex-col items-center gap-3 px-8 py-10 text-center">
      <Captions className="size-7 text-subtle" />
      <p className="text-sm font-medium text-fg">{t('media.noTranscript')}</p>
      <p className="max-w-[320px] text-xs leading-relaxed text-muted">
        {cloud
          ? t('media.noTranscriptCloud')
          : asr?.state === 'ready'
            ? t('media.noTranscriptReady')
            : t('media.noTranscriptDesc', { size: formatBytes(ASR_DOWNLOAD) })}
      </p>
      {(failed || asr?.state === 'error') && (
        <p className="max-w-[320px] text-2xs break-all text-danger">{failed?.error ?? asr?.message}</p>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="primary" onClick={start}>
          <Captions />
          {t('media.transcribe')}
        </Button>
        <Button size="sm" variant="outline" onClick={importSub}>
          <FileUp />
          {t('media.importSubtitles')}
        </Button>
      </div>
    </div>
  )
}

export function MediaPane({ source }: { source: Source }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const pane = useRef<HTMLDivElement>(null)
  const [organizing, setOrganizing] = useState(false),
    setSourceFocus = useApp((s) => s.setSourceFocus),
    [wide, setWide] = useState(false),
    [tab, setTab] = useState<'transcript' | 'review'>('review'),
    [evidence, setEvidence] = useState<EvidenceSentence | null>(null)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [range, setRange] = useState<{ a: number; b: number | null } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const follow = useRef(0)
  const followed = useRef<string | null>(null)
  const [structureVersion, setStructureVersion] = useState(0)
  const structureChanged = useCallback(() => setStructureVersion((v) => v + 1), [])
  const sampleUntil = useRef<number | null>(null)
  const setContext = useApp((s) => s.setContext)
  const highlight = useApp((s) => s.highlight)
  const onSelect = useSourceSelection(source.id)
  const isVideo = source.kind === 'video'
  const { data: crypto, refetch: refreshCrypto } = useQuery({
    queryKey: ['recording-crypto'],
    queryFn: () => api.recording.cryptoStatus(),
    enabled: source.kind === 'recording'
  })
  const [unlockClosed, setUnlockClosed] = useState(false)

  const { data: segs = [] } = useQuery({ queryKey: ['segments', source.id], queryFn: () => api.segments.list(source.id) })
  const { data: retainedHistory = [] } = useQuery({
    queryKey: ['lens-history', source.id],
    queryFn: () => api.lenses.history(source.id),
    enabled: source.aiExcluded
  })
  // 转写稿上的批注高亮
  const annotations = useAnnotations('source', source.id)
  const hlVersion = useMemo(() => ({ segs, editing, structureVersion }), [segs, editing, structureVersion])
  useTextHighlights(`media:${source.id}`, list, annotations, hlVersion)
  const { data: threads = [] } = useQuery({ queryKey: ['threads', source.id], queryFn: () => api.chat.threads(source.id) })
  useEffect(
    () =>
      window.jiweiEvents.on('segments:changed', (p) => {
        if (p.sourceId === source.id) void qc.invalidateQueries({ queryKey: ['segments', source.id] })
      }),
    [qc, source.id]
  )
  const timed = useMemo(
    () => segs.map((s) => ({ s, t: segTime(s) })).filter((x): x is { s: Segment; t: [number, number] } => !!x.t),
    [segs]
  )
  const current = timed.find((x) => time >= x.t[0] && time < x.t[1] + 0.5)?.s.id ?? null

  const seek = (sec: number, play = false, until?: number): void => {
    setTime(sec)
    const m = media.current
    if (!m) return
    sampleUntil.current = until ?? null
    m.currentTime = Math.max(0, sec)
    if (play) void m.play().catch(() => {})
  }
  useEffect(() => {
    setSourceFocus(organizing)
    return () => setSourceFocus(false)
  }, [organizing, setSourceFocus])
  useEffect(() => {
    const el = pane.current
    if (!el) return
    const measure = (): void => setWide(el.clientWidth >= 640 && window.innerWidth > 1000)
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    window.addEventListener('resize', measure)
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])
  useEffect(() => {
    if (!evidence || !organizing) return
    const frame = requestAnimationFrame(() =>
      list.current?.querySelector<HTMLElement>(`[data-segment="${CSS.escape(evidence.segmentId)}"]`)?.scrollIntoView({ block: 'center' })
    )
    return () => cancelAnimationFrame(frame)
  }, [evidence, tab, wide, organizing])
  const showEvidence = (sentence: EvidenceSentence): void => {
    setTab('transcript')
    setEvidence(sentence)
    seek(sentence.start, !!source.assetUrl, sentence.end)
    follow.current = 0
  }

  // 出处链接 / AI 引用：跳到对应时间并播放
  useEffect(() => {
    if (!highlight || highlight.type !== 'segment') return
    const tm = highlight.locator?.match(/t=([\d.]+)/)
    const seg = timed.find((x) => x.s.id === highlight.id)
    const at = tm ? Number(tm[1]) : seg?.t[0]
    if (at === undefined) return
    seek(at, true)
    follow.current = 0
    useApp.getState().setHighlight(null)
  }, [highlight, timed])

  // 跟随播放滚动转写稿
  useEffect(() => {
    if (!current || Date.now() < follow.current || followed.current === current) return
    followed.current = current
    list.current?.querySelector<HTMLElement>(`[data-segment="${current}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [current, time])

  const onTime = (): void => {
    const now = media.current?.currentTime ?? 0
    if (sampleUntil.current !== null && now >= sampleUntil.current) {
      media.current?.pause()
      sampleUntil.current = null
    }
    setTime(now)
    const cur = timed.find((x) => now >= x.t[0] && now < x.t[1] + 0.5)
    setContext({ sourceLocator: `t=${Math.floor(now)}`, ...(cur ? { sourceSegmentId: cur.s.id } : {}) })
  }

  const pause = (): void => media.current?.pause()
  const anchorFor = (kind: Anchor['kind'], t0: number, t1: number): Anchor => {
    const r = rangeText(segs, t0, t1)
    return { kind, parentType: 'source', parentId: source.id, ownerId: r.ownerId, quote: r.text || undefined, t: [t0, t1] }
  }

  /** 「没听懂」：当前时刻前 30 秒到后 3 秒 */
  const notGetIt = (e: React.MouseEvent): void => {
    pause()
    if (!segs.length) return void toast(t('media.needTranscript'))
    const a = anchorFor('media-range', Math.max(0, time - 30), time + 3)
    setRange({ a: a.t![0], b: a.t![1] })
    void askInline('clarify', a, elementRect(e.currentTarget))
  }

  /** A–B 区间：第一次点击定起点，第二次定终点并提问 */
  const markRange = (e: React.MouseEvent): void => {
    if (!range || range.b !== null) return setRange({ a: time, b: null })
    pause()
    const a = Math.min(range.a, time)
    const b = Math.max(range.a, time)
    setRange({ a, b })
    if (b - a < 1) return
    useAssist.getState().openCard({
      anchor: anchorFor('media-range', a, b),
      rect: elementRect(e.currentTarget),
      action: 'ask',
      conversationId: null,
      question: ''
    })
  }

  /** 「问这个画面」：截取当前帧 + 前后 15 秒转写稿 */
  const askFrame = (e: React.MouseEvent): void => {
    const v = media.current
    if (!v || !v.videoWidth) return
    pause()
    const k = Math.min(1, 1280 / v.videoWidth)
    const c = document.createElement('canvas')
    c.width = Math.round(v.videoWidth * k)
    c.height = Math.round(v.videoHeight * k)
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height)
    let image: string
    try {
      image = c.toDataURL('image/png')
    } catch {
      return void toast.error(t('media.frameError'))
    }
    const anchor = { ...anchorFor('region', Math.max(0, time - 15), time + 15), t: [time, time] as [number, number] }
    useAssist.getState().openCard({ anchor, rect: elementRect(e.currentTarget), action: 'ask', conversationId: null, question: '', image })
  }

  const openThread = (c: Conversation, rect: Rect): void =>
    useAssist.getState().openCard({ anchor: c.anchor!, rect, action: 'ask', conversationId: c.id, question: c.title })

  const pct = (sec: number): string => `${duration ? Math.min(100, (sec / duration) * 100) : 0}%`

  const props = {
    ref: media,
    // 锁住时不把 423 响应交给媒体管线；Chromium 会复用同地址的失败结果。
    // 解锁状态确认后挂载真实音源，React 的 src 更新触发正常加载与拖动。
    src: source.kind === 'recording' && crypto?.unlocked !== true ? undefined : (source.assetUrl ?? undefined),
    controls: true,
    crossOrigin: 'anonymous' as const,
    onTimeUpdate: onTime,
    onSeeked: onTime,
    onLoadedMetadata: () => setDuration(media.current?.duration ?? 0)
  }

  return (
    <div
      ref={pane}
      className="flex h-full min-h-0 min-w-0 flex-col"
      data-testid="lens-workspace"
      data-layout={organizing ? (wide ? 'columns' : 'tabs') : 'transcript'}
    >
      <RecoveryCodeDialog
        open={source.kind === 'recording' && crypto?.unlocked === false && !unlockClosed}
        unlocked
        close={() => setUnlockClosed(true)}
        onDone={() => {
          void refreshCrypto()
        }}
      />
      {source.kind === 'recording' && crypto?.unlocked === false && (
        <div className="safety-ui px-4 py-3 text-sm text-muted" data-testid="recording-locked-hint">
          录音已加密，需要恢复码才能播放。
          <Button variant="outline" className="ml-2" onClick={() => setUnlockClosed(false)}>
            输入恢复码
          </Button>
        </div>
      )}
      {!!segs.length && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
          <Button
            size="sm"
            variant="outline"
            disabled={source.aiExcluded && !organizing}
            title={source.aiExcluded ? t('lens.local') : undefined}
            onClick={() => {
              setOrganizing(true)
              setTab('review')
            }}
          >
            <Sparkles />
            {t('lens.organize')}
          </Button>
          {source.aiExcluded && !!retainedHistory.length && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOrganizing(true)
                setTab('review')
              }}
            >
              {t('lens.review')}
            </Button>
          )}
          {organizing && !wide && (
            <div className="flex gap-1" role="tablist" aria-label={t('lens.review')}>
              {(['transcript', 'review'] as const).map((id) => (
                <Button
                  role="tab"
                  aria-selected={tab === id}
                  variant={tab === id ? 'secondary' : 'ghost'}
                  size="sm"
                  key={id}
                  onClick={() => setTab(id)}
                >
                  {t(`lens.${id}`)}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className={cn('min-h-0 flex-1', organizing && wide ? 'grid grid-cols-2' : 'flex flex-col')}>
        <div className={cn('h-full min-h-0 min-w-0 flex-col', organizing && !wide && tab === 'review' ? 'hidden' : 'flex')}>
          {!source.assetUrl ? (
            <p className="shrink-0 px-5 py-4 text-xs text-muted">{t('recording.audioRemoved')}</p>
          ) : isVideo ? (
            <div className="flex max-h-[48%] shrink-0 items-center justify-center bg-black">
              <video {...props} className="max-h-full w-full" data-testid="media" />
            </div>
          ) : (
            <div className="shrink-0 px-5 pt-5">
              <audio {...props} className="w-full" data-testid="media" />
            </div>
          )}

          {/* 时间轴：就地提问标记、A–B 区间、当前位置 */}
          <div className="shrink-0 px-4 pt-3">
            <div
              className="relative h-5 cursor-pointer"
              aria-label={t('media.timeline')}
              onClick={(e) => {
                const b = e.currentTarget.getBoundingClientRect()
                seek(((e.clientX - b.left) / b.width) * duration)
              }}
            >
              <div className="absolute inset-x-0 top-2 h-1 rounded-full bg-border" />
              {range && (
                <div
                  className="absolute top-1.5 h-2 rounded-full bg-accent/35"
                  style={{ left: pct(range.a), width: range.b !== null ? `calc(${pct(range.b)} - ${pct(range.a)})` : '2px' }}
                />
              )}
              <div className="absolute top-1 h-3 w-0.5 rounded bg-fg/70" style={{ left: pct(time) }} />
              {threads
                .filter((c) => c.anchor?.t)
                .map((c) => (
                  <button
                    key={c.id}
                    title={c.title}
                    aria-label={t('assist.thread', { title: c.title })}
                    className="thread-dot absolute top-0.5 -translate-x-1/2"
                    style={{ left: pct(c.anchor!.t![0]) }}
                    onClick={(e) => {
                      e.stopPropagation()
                      seek(c.anchor!.t![0])
                      openThread(c, elementRect(e.currentTarget))
                    }}
                  />
                ))}
            </div>
          </div>

          {/* 操作 */}
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-4 py-2">
            <Tip label={t('media.notGetItHint')} side="bottom">
              <Button size="sm" variant={organizing ? 'outline' : 'primary'} onClick={notGetIt}>
                <CircleHelp />
                {t('media.notGetIt')}
              </Button>
            </Tip>
            <Tip label={t('media.rangeHint')} side="bottom">
              <Button
                size="sm"
                variant={range && range.b === null ? 'secondary' : 'outline'}
                onClick={markRange}
                aria-pressed={!!range && range.b === null}
              >
                <Scissors />
                {range && range.b === null ? t('media.rangeEnd', { t: fmtTime(range.a) }) : t('media.range')}
              </Button>
            </Tip>
            {isVideo && (
              <Tip label={t('media.frameHint')} side="bottom">
                <Button size="sm" variant="outline" onClick={askFrame}>
                  <Camera />
                  {t('media.frame')}
                </Button>
              </Tip>
            )}
            {range && (
              <span className="inline-flex items-center gap-1 rounded-md bg-sunken px-2 py-1 text-2xs text-muted tabular-nums">
                {fmtTime(range.a)}
                {range.b !== null && ` – ${fmtTime(range.b)}`}
                <button aria-label={t('media.clearRange')} onClick={() => setRange(null)} className="hover:text-fg">
                  <X className="size-3" />
                </button>
              </span>
            )}
            <span className="ml-auto text-2xs text-subtle tabular-nums">
              {fmtTime(time)}
              {duration ? ` / ${fmtTime(duration)}` : ''}
            </span>
          </div>

          {/* 转写稿 */}
          <div
            ref={list}
            className="min-h-0 flex-1 overflow-y-auto"
            onWheel={() => {
              follow.current = Date.now() + 5000
              followed.current = null
            }}
            onTouchMove={() => {
              follow.current = Date.now() + 5000
              followed.current = null
            }}
            onMouseUp={onSelect}
            onKeyUp={onSelect}
          >
            {segs.length === 0 ? (
              <TranscriptEmpty source={source} />
            ) : source.kind === 'recording' || segs.some((s) => s.locator.speaker) ? (
              <TranscriptView
                source={source}
                segments={segs.filter((s) => s.kind === 'transcript')}
                time={time}
                seek={seek}
                threads={threads}
                onThread={openThread}
                onStructureChange={structureChanged}
                highlightedId={evidence?.segmentId}
              />
            ) : (
              <article className="source-text transcript select-text" aria-label={t('media.transcript')}>
                {timed.map(({ s, t: tt }) => (
                  <p
                    key={s.id}
                    data-segment={s.id}
                    data-t0={tt[0]}
                    data-t1={tt[1]}
                    className={cn('transcript-line', current === s.id && 'is-current')}
                  >
                    {threads.some((c) => c.anchor?.ownerId === s.id) && (
                      <span className="thread-marks" contentEditable={false}>
                        {threads
                          .filter((c) => c.anchor?.ownerId === s.id)
                          .map((c) => (
                            <button
                              key={c.id}
                              className="thread-dot"
                              title={c.title}
                              onMouseUp={(e) => e.stopPropagation()}
                              onClick={(e) => openThread(c, elementRect(e.currentTarget))}
                            />
                          ))}
                      </span>
                    )}
                    <button
                      className="transcript-time"
                      onMouseUp={(e) => e.stopPropagation()}
                      onClick={() => {
                        follow.current = 0
                        seek(tt[0], true)
                      }}
                    >
                      {fmtTime(tt[0])}
                    </button>
                    {editing === s.id ? (
                      <LineEditor seg={s} onDone={() => setEditing(null)} />
                    ) : (
                      <>
                        {s.text}
                        <button
                          className="transcript-edit"
                          aria-label={t('media.editLine')}
                          title={t('media.editLine')}
                          onMouseUp={(e) => e.stopPropagation()}
                          onClick={() => setEditing(s.id)}
                        >
                          <Pencil className="size-3" />
                        </button>
                      </>
                    )}
                  </p>
                ))}
              </article>
            )}
          </div>
        </div>
        {organizing && (
          <div className={cn('h-full min-h-0 min-w-0 border-border', wide && 'border-l', !wide && tab === 'transcript' && 'hidden')}>
            <LensPanel source={source} onEvidence={showEvidence} onClose={() => setOrganizing(false)} />
          </div>
        )}
      </div>
    </div>
  )
}
