import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronDown, ChevronUp, Clock, CircleHelp, Captions, Images, NotebookPen, Brain, Mic, Loader2, X, FileUp } from 'lucide-react'
import { fmtTime, type Anchor } from '@shared/context'
import { segmentTime } from '@shared/course'
import type { BrowserTab, CourseQuiz } from '@shared/types'
import { api, cn, modKey } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { useSourceSelection } from '../workspace/SourcePane'
import { askInline } from '../assist/actions'
import { errText } from '../chat/useChat'
import { useAnnotations } from '../annotate/store'
import { useTextHighlights } from '../annotate/textHighlights'
import { useBrowser } from './store'
import { requestTimestamp } from './courseNotes'

export function CoursePanel({ tab }: { tab: BrowserTab }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const root = useRef<HTMLDivElement>(null),
    list = useRef<HTMLDivElement>(null)
  const [collapsed, setCollapsed] = useState(true),
    [height, setHeight] = useState(200)
  const follow = useRef(true)
  const [organizing, setOrganizing] = useState(false)
  const [quiz, setQuiz] = useState<CourseQuiz | null>(null),
    [quizzing, setQuizzing] = useState(false)
  const [response, setResponse] = useState(''),
    [revealed, setRevealed] = useState(false),
    [feedback, setFeedback] = useState('')
  const [checking, setChecking] = useState(false)
  const lastQuiz = useRef(0),
    watched = useRef(0),
    resume = useRef(false),
    quizBusy = useRef(false)
  const mounted = useRef(true),
    resizeCleanup = useRef<(() => void) | null>(null)
  const noteId = useApp((s) => s.noteId),
    sourceId = tab.sourceId,
    video = tab.video!
  const { data: segments = [] } = useQuery({
    queryKey: ['segments', sourceId],
    queryFn: () => api.segments.list(sourceId!),
    enabled: !!sourceId
  })
  const { data: asr } = useQuery({ queryKey: ['asr'], queryFn: () => api.asr.status() })
  const { data: moss } = useQuery({ queryKey: ['moss'], queryFn: () => api.moss.status() })
  const { data: jobs = [] } = useQuery({ queryKey: ['jobs'], queryFn: () => api.jobs.list() })
  const { data: estimate } = useQuery({
    queryKey: ['course-cost', sourceId, segments.length],
    queryFn: () => api.course.estimate(sourceId!),
    enabled: !!sourceId
  })
  const onSelect = useSourceSelection(sourceId ?? '')
  const annotations = useAnnotations('source', sourceId ?? '')
  // 收起面板或打开练习会换掉正文 DOM，展开时必须重新定位批注并绑定点击。
  const highlightVersion = useMemo(() => ({ segments, collapsed, quizOpen: !!quiz || quizzing }), [segments, collapsed, quiz, quizzing])
  useTextHighlights(`course:${sourceId}`, list, annotations, highlightVersion)
  const transcript = useMemo(
    () =>
      segments
        .filter((s) => s.kind === 'transcript')
        .map((s) => ({ s, time: segmentTime(s) }))
        .filter((x) => x.time),
    [segments]
  )
  const slides = useMemo(
    () => segments.filter((s) => s.kind === 'slide').sort((a, b) => (segmentTime(a)?.[0] ?? 0) - (segmentTime(b)?.[0] ?? 0)),
    [segments]
  )
  const current = transcript.find(({ time }) => video.currentTime >= time![0] && video.currentTime < time![1] + 0.5)?.s.id
  const mossJob = jobs.find((j) => j.key === `moss:${sourceId}` && (j.status === 'queued' || j.status === 'running'))
  const fail = (e: unknown): void => {
    toast.error(errText(e))
  }
  const source = async (): Promise<string> => sourceId ?? api.browser.saveSource(tab.id)
  const configure = (patch: Parameters<typeof api.course.configure>[1]): void => {
    void api.course.configure(tab.id, patch).catch(fail)
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      resizeCleanup.current?.()
    }
  }, [])

  useLayoutEffect(() => {
    const available = (root.current?.parentElement?.clientHeight ?? 600) - 73
    const panelHeight = Math.max(160, Math.round(available * 0.34))
    // 520px按展开后网页的可用高度判断，小窗口先保留播放器，用户可主动展开面板。
    setCollapsed(available - panelHeight < 520)
    setHeight(panelHeight)
  }, [])

  useEffect(() => {
    const offs = [
      window.jiweiEvents.on('segments:changed', (p) => {
        if (p.sourceId === sourceId) void qc.invalidateQueries({ queryKey: ['segments', sourceId] })
      }),
      window.jiweiEvents.on('asr:status', (s) => qc.setQueryData(['asr'], s)),
      window.jiweiEvents.on('moss:status', (s) => qc.setQueryData(['moss'], s)),
      window.jiweiEvents.on('jobs:changed', () => {
        void qc.invalidateQueries({ queryKey: ['jobs'] })
      })
    ]
    return () => offs.forEach((off) => off())
  }, [qc, sourceId])
  useEffect(() => {
    if (asr?.state === 'ready' && tab.course.transcript === 'needs-install')
      void api.course.configure(tab.id, { mode: 'local' }).catch(fail)
  }, [asr?.state, tab.course.transcript, tab.id])
  useEffect(() => {
    if (current && follow.current)
      list.current?.querySelector(`[data-segment="${current}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [current])

  const organize = async (): Promise<void> => {
    if (organizing) return
    setOrganizing(true)
    try {
      const r = await api.course.organize(await source(), useApp.getState().noteId)
      useApp.getState().openNote(r.noteId)
      toast.success(t('course.proposalReady'))
    } catch (e) {
      fail(e)
    } finally {
      setOrganizing(false)
    }
  }
  const beginQuiz = async (): Promise<void> => {
    if (quizBusy.current || quiz || quizzing) return
    quizBusy.current = true
    setQuizzing(true)
    setCollapsed(false)
    lastQuiz.current = Date.now()
    resume.current = !video.paused
    try {
      await api.browser.playback(tab.id, false)
      const q = await api.course.quiz(tab.id)
      if (!mounted.current || !latest.current.tab.course.quiz) return
      watched.current = 0
      setQuiz(q)
      setResponse('')
      setRevealed(false)
      setFeedback('')
    } catch (e) {
      if (mounted.current) {
        fail(e)
        if (resume.current) await api.browser.playback(tab.id, true).catch(fail)
      }
    } finally {
      if (mounted.current) setQuizzing(false)
      quizBusy.current = false
    }
  }
  const latest = useRef({ tab, beginQuiz, organize })
  latest.current = { tab, beginQuiz, organize }
  useEffect(
    () =>
      window.jiweiEvents.on('course:event', (e) => {
        if (e.tabId !== latest.current.tab.id) return
        if (e.kind === 'error') toast.error(t(`course.errors.${e.message}`, { defaultValue: e.message }))
        if (
          e.kind === 'slide' &&
          latest.current.tab.course.quiz &&
          !latest.current.tab.video?.paused &&
          Date.now() - lastQuiz.current > 300000
        )
          void latest.current.beginQuiz()
        if (e.kind === 'ended')
          void api.settings.get().then((s) => {
            if (mounted.current && s.browser?.proactivity !== 'quiet')
              toast(t('course.ended'), {
                action: {
                  label: t('course.organize'),
                  onClick: () => {
                    if (mounted.current) void latest.current.organize()
                  }
                }
              })
          })
      }),
    [t]
  )
  useEffect(() => {
    if (!tab.course.quiz || slides.length || video.paused || quiz || quizzing) return
    // 只累计实际观看时间，暂停几小时后继续不能立刻被一道旧题打断。
    let previous = Date.now()
    const timer = setInterval(() => {
      const now = Date.now()
      watched.current += Math.min(2000, now - previous)
      previous = now
      if (watched.current >= 480000) void latest.current.beginQuiz()
    }, 1000)
    return () => clearInterval(timer)
  }, [tab.course.quiz, slides.length, video.paused, quiz, quizzing])
  const closeQuiz = async (): Promise<void> => {
    setQuiz(null)
    if (resume.current) await api.browser.playback(tab.id, true).catch(fail)
  }
  useEffect(() => {
    if (!tab.course.quiz) {
      watched.current = 0
      if (quiz || quizzing) {
        setQuiz(null)
        if (resume.current) void api.browser.playback(tab.id, true).catch(fail)
      }
    }
  }, [tab.course.quiz, tab.id, quiz, quizzing])

  const notGet = async (): Promise<void> => {
    try {
      const fresh = (await api.browser.state()).tabs.find((t) => t.id === tab.id)
      if (!fresh?.video || fresh.video.mediaId !== video.mediaId) return
      const at = fresh.video.currentTime,
        start = Math.max(0, at - 30)
      await api.browser.playback(tab.id, false)
      const sid = await source()
      const image = await api.course.snapshot(tab.id)
      if (!mounted.current) return
      const recent = transcript.filter(({ time }) => time![1] >= start && time![0] <= at)
      const anchor: Anchor = {
        kind: 'media-range',
        parentType: 'source',
        parentId: sid,
        ownerId: recent[0]?.s.id ?? null,
        t: [start, at],
        quote:
          recent
            .map(({ s }) => s.text)
            .join(' ')
            .slice(0, 4000) || undefined
      }
      if (!recent.length) toast(t('course.betterTranscript'))
      if (!image) toast(t('course.errors.frame-blocked'))
      const bounds = document.querySelector('[data-testid="browser-view"]')!.getBoundingClientRect()
      const rect = { x: bounds.right + 222, y: bounds.top + 60, w: 0, h: 0 }
      await askInline('clarify', anchor, rect, t('course.notGetQuestion'), image ?? undefined)
    } catch (e) {
      fail(e)
    }
  }
  const resize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    resizeCleanup.current?.()
    const y = event.clientY,
      initial = height
    let stopped = false
    event.currentTarget.setPointerCapture(event.pointerId)
    void api.browser
      .freeze(true)
      .then((img) => {
        if (!stopped) useBrowser.getState().setFrozen(img ?? '')
      })
      .catch(fail)
    const move = (e: PointerEvent): void =>
      setHeight(Math.max(160, Math.min((root.current?.parentElement?.clientHeight ?? 600) - 180, initial + y - e.clientY)))
    const stop = (): void => {
      if (stopped) return
      stopped = true
      resizeCleanup.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      void api.browser.freeze(false)
      useBrowser.getState().setFrozen(null)
    }
    resizeCleanup.current = stop
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
    window.addEventListener('pointercancel', stop, { once: true })
  }
  const tool = (key: string, icon: React.ReactNode, action: () => void, pressed?: boolean, disabled = false, hint?: string) => (
    <Tip label={hint ?? t(`course.${key}`)} side="top">
      <Button
        size="icon-sm"
        variant={pressed ? 'secondary' : 'ghost'}
        aria-label={t(`course.${key}`)}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={action}
        className="size-7 shrink-0 [&_svg]:size-3.5"
      >
        {icon}
      </Button>
    </Tip>
  )

  return (
    <div
      ref={root}
      data-testid="course-panel"
      data-collapsed={collapsed}
      className="relative flex shrink-0 flex-col border-t border-border bg-surface"
      style={{ height: collapsed ? 32 : height }}
    >
      {!collapsed && (
        <div
          role="separator"
          aria-label={t('course.resize')}
          aria-orientation="horizontal"
          tabIndex={0}
          className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
          onPointerDown={resize}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault()
              setHeight((h) => Math.max(160, Math.min(500, h + (e.key === 'ArrowUp' ? 20 : -20))))
            }
          }}
        />
      )}
      {/* 工具条在窄栏中换行，所有操作都可见（不横向滚动） */}
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-0.5 px-2 py-0.5">
        {tool(collapsed ? 'expand' : 'collapse', collapsed ? <ChevronUp /> : <ChevronDown />, () => setCollapsed(!collapsed))}
        <span className="mr-1 shrink-0 text-2xs text-muted tabular-nums">
          {fmtTime(video.currentTime)} / {fmtTime(video.duration)}
        </span>
        {tool('timestamp', <Clock />, requestTimestamp, undefined, !noteId, `${t('course.timestamp')} · ${modKey}⇧T`)}
        {tool('notGet', <CircleHelp />, () => void notGet())}
        {tool('transcribe', <Captions />, () => configure({ mode: tab.course.mode === 'off' ? 'auto' : 'off' }), tab.course.mode !== 'off')}
        {tool('slides', <Images />, () => configure({ slides: !tab.course.slides }), tab.course.slides)}
        {tool(
          'organize',
          organizing ? <Loader2 className="animate-spin" /> : <NotebookPen />,
          () => void organize(),
          undefined,
          organizing,
          t('course.estimate', { cost: estimate == null ? t('course.costUnknown') : `$${estimate.toFixed(4)}` })
        )}
        {tool('quiz', <Brain />, () => configure({ quiz: !tab.course.quiz }), tab.course.quiz)}
        {tool(
          'refine',
          mossJob ? <Loader2 className="animate-spin" /> : <Mic />,
          () => {
            if (moss?.state !== 'ready') {
              toast(t('course.mossDownload'), {
                action: { label: t('course.install'), onClick: () => void api.moss.install().catch(fail) }
              })
              return
            }
            void source()
              .then((sid) => api.moss.refine(sid))
              .catch(fail)
          },
          undefined,
          !tab.course.recordingComplete || !!mossJob,
          !tab.course.recordingComplete ? t('course.needRecording') : t('course.refineHint')
        )}
      </div>
      {!collapsed && (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/50 px-3 pb-1 text-2xs text-subtle">
            <span role="status">{t(`course.status.${tab.course.transcript}`)}</span>
            {tab.course.mode !== 'off' && (
              <Tip label={t('course.local')}>
                <button aria-label={t('course.local')} className="text-accent" onClick={() => configure({ mode: 'local' })}>
                  {t('course.local')}
                </button>
              </Tip>
            )}
            {tab.course.transcript === 'needs-install' && (
              <Tip label={t('course.installAsr')}>
                <button aria-label={t('course.installAsr')} className="text-accent" onClick={() => void api.asr.install().catch(fail)}>
                  {asr?.state === 'downloading' ? `${Math.round(asr.progress * 100)}%` : t('course.installAsr')}
                </button>
              </Tip>
            )}
            <Tip label={t('media.importSubtitles')}>
              <button
                aria-label={t('media.importSubtitles')}
                className="flex items-center gap-1 text-accent"
                onClick={() =>
                  void source()
                    .then((sid) => api.asr.importSubtitles(sid))
                    .catch(fail)
                }
              >
                <FileUp className="size-3" />
                {t('media.importSubtitles')}
              </button>
            </Tip>
            {mossJob && <span>{t('course.refining', { p: Math.round(mossJob.progress * 100) })}</span>}
            {tab.course.error && (
              <span className="text-danger">{t(`course.errors.${tab.course.error}`, { defaultValue: tab.course.error })}</span>
            )}
          </div>
          {quiz || quizzing ? (
            <div data-testid="course-quiz" className="min-h-0 flex-1 space-y-2 overflow-auto p-3 text-xs">
              {quizzing ? (
                <p role="status" className="flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin" />
                  {t('course.generating')}
                </p>
              ) : (
                quiz && (
                  <>
                    <div className="flex items-start gap-2">
                      <p className="flex-1 font-medium">{quiz.question}</p>
                      {tool('skip', <X />, () => void closeQuiz())}
                    </div>
                    <textarea
                      aria-label={t('course.answer')}
                      value={response}
                      onChange={(e) => setResponse(e.target.value)}
                      className="min-h-14 w-full rounded border border-border bg-sunken p-2 outline-none focus:border-accent"
                    />
                    {!revealed ? (
                      <Tip label={t('course.compare')}>
                        <Button
                          size="sm"
                          aria-label={t('course.compare')}
                          disabled={checking}
                          onClick={() => {
                            setRevealed(true)
                            setChecking(true)
                            void api.course
                              .check(quiz.id, response)
                              .then(setFeedback)
                              .catch(fail)
                              .finally(() => setChecking(false))
                          }}
                        >
                          {t('course.compare')}
                        </Button>
                      </Tip>
                    ) : (
                      <>
                        <p>{quiz.answer}</p>
                        <p className="text-muted">{checking ? t('course.checking') : feedback}</p>
                        <div className="flex gap-2">
                          <Tip label={t('course.remembered')}>
                            <Button size="sm" aria-label={t('course.remembered')} onClick={() => void closeQuiz()}>
                              {t('course.remembered')}
                            </Button>
                          </Tip>
                          <Tip label={t('course.addReview')}>
                            <Button
                              size="sm"
                              aria-label={t('course.addReview')}
                              onClick={() =>
                                void api.course
                                  .review(quiz.id, useApp.getState().noteId)
                                  .then((r) => {
                                    useApp.getState().openNote(r.noteId)
                                    return closeQuiz()
                                  })
                                  .catch(fail)
                              }
                            >
                              {t('course.addReview')}
                            </Button>
                          </Tip>
                        </div>
                      </>
                    )}
                  </>
                )
              )}
            </div>
          ) : (
            <div className="course-content flex min-h-0 flex-1">
              {slides.length > 0 && (
                <div className="course-slides flex shrink-0 gap-2 overflow-auto p-2" aria-label={t('course.slides')}>
                  {slides.map((slide) => {
                    const at = segmentTime(slide)?.[0] ?? 0
                    return (
                      <Tip key={slide.id} label={t('course.jump', { time: fmtTime(at) })}>
                        <button
                          data-testid="course-slide"
                          aria-label={t('course.jump', { time: fmtTime(at) })}
                          className="w-24 shrink-0 text-left text-2xs text-muted"
                          onClick={() => void api.browser.seek(tab.id, at, true)}
                        >
                          <img
                            src={`jiwei://asset/${slide.locator.image}.jpg`}
                            alt={slide.text || t('course.slide', { time: fmtTime(at) })}
                            className="aspect-video w-full rounded border border-border object-cover"
                          />
                          {fmtTime(at)}
                        </button>
                      </Tip>
                    )
                  })}
                </div>
              )}
              <div
                ref={list}
                className="min-h-0 min-w-0 flex-1 overflow-y-auto"
                onWheel={() => {
                  follow.current = false
                }}
                onMouseUp={onSelect}
                onKeyUp={onSelect}
              >
                <article data-testid="course-transcript" className="source-text transcript select-text" aria-label={t('media.transcript')}>
                  {transcript.length ? (
                    transcript.map(({ s, time }) => (
                      <p
                        key={s.id}
                        data-segment={s.id}
                        data-t0={time![0]}
                        data-t1={time![1]}
                        className={cn('transcript-line', current === s.id && 'is-current')}
                      >
                        <Tip label={t('course.jump', { time: fmtTime(time![0]) })}>
                          <button
                            className="transcript-time"
                            aria-label={t('course.jump', { time: fmtTime(time![0]) })}
                            onMouseUp={(e) => e.stopPropagation()}
                            onClick={() => {
                              follow.current = true
                              void api.browser.seek(tab.id, time![0], true)
                            }}
                          >
                            {fmtTime(time![0])}
                          </button>
                        </Tip>
                        {s.text}
                      </p>
                    ))
                  ) : (
                    <p className="p-3 text-xs text-muted">{t('course.empty')}</p>
                  )}
                </article>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
