import { useReadinessMany } from '../library/useReadiness'
import { ReadinessBanner } from '../library/ReadinessNotice'
import { FORMATS } from '@shared/formats'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { X, ExternalLink, Loader2, FileQuestion, Highlighter, Globe } from 'lucide-react'
import type { Conversation, Segment, Source } from '@shared/types'
import { api, cn, formatBytes } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { KIND_ICON } from '../library/LibraryView'
import { KIND_TINT } from '@/lib/tint'
import { useAssist, elementRect } from '../assist/store'
import { textSelectionAnchor } from '../assist/actions'
import { PdfViewer } from './PdfViewer'
import { MediaPane } from './MediaPane'
import { RecognitionBar } from './RecognitionBar'
import { useAnnotations } from '../annotate/store'
import { useTextHighlights } from '../annotate/textHighlights'
import { AnnotationsPanel } from '../annotate/AnnotationsPanel'
import { ReadingControls, useReadingState } from '../reading/ReadingControls'
import { ReadingSourceText } from '../reading/ReadingText'

// 工作区左栏：在应用内查看资料，并把“看到哪里 / 选中了什么”同步到工作区上下文。

function TextSegments({ source }: { source: Source }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: segs, isFetched } = useQuery({ queryKey: ['segments', source.id], queryFn: () => api.segments.list(source.id) })
  const { data: reading } = useReadingState({ kind: 'source', id: source.id })
  useEffect(
    () =>
      window.jiweiEvents.on('segments:changed', (p) => {
        if (p.sourceId === source.id) void qc.invalidateQueries({ queryKey: ['segments', source.id] })
      }),
    [qc, source.id]
  )
  if (!isFetched) return <Centered icon={<Loader2 className="animate-spin" />} />
  if (!segs?.length) return <Centered icon={<Loader2 className="animate-spin" />} text={t('workspace.parsing')} />
  if (reading?.foreign && (reading.mode !== 'original' || reading.annotations))
    return <ReadingSourceText sourceId={source.id} segments={segs} />
  return <SegmentList sourceId={source.id} segs={segs} />
}

/** 选中资料文字：同步到工作区上下文，并弹出选区浮条 */
export function useSourceSelection(sourceId: string): () => void {
  const setContext = useApp((s) => s.setContext)
  return () => {
    // 等浏览器完成选区更新
    requestAnimationFrame(() => {
      const r = textSelectionAnchor(sourceId)
      setContext({ sourceSelection: r?.anchor.quote?.slice(0, 4000) ?? null, sourceSegmentId: r?.anchor.ownerId ?? null })
      useAssist.getState().showToolbar(r && r.anchor.quote!.length >= 1 ? r : null)
    })
  }
}

/** 片段的位置属性：页码 / 时间段（用于锚点） */
function segAttrs(s: Segment): Record<string, string> {
  const v = String((s.locator as { value?: unknown }).value ?? '')
  const page = typeof s.locator.page === 'number' ? String(s.locator.page) : v.match(/page=(\d+)/)?.[1]
  const t = v.match(/t=([\d.]+)(?:,([\d.]+))?/)
  return {
    'data-segment': s.id,
    ...(page ? { 'data-page': page } : {}),
    ...(t ? { 'data-t0': t[1], 'data-t1': t[2] ?? t[1] } : {})
  }
}

/** 原文边缘的就地提问标记：点开回到当时的对话 */
function ThreadMarks({ threads, segId }: { threads: Conversation[]; segId: string }) {
  const { t } = useTranslation()
  const mine = threads.filter((c) => c.anchor?.ownerId === segId)
  if (!mine.length) return null
  return (
    <span className="thread-marks" contentEditable={false} data-jiwei-ui="threads">
      {mine.map((c) => (
        <button
          key={c.id}
          className="thread-dot"
          aria-label={t('assist.thread', { title: c.title })}
          title={c.title}
          onMouseUp={(e) => e.stopPropagation()}
          onClick={(e) =>
            useAssist.getState().openCard({
              anchor: c.anchor!,
              rect: elementRect(e.currentTarget),
              action: 'ask',
              conversationId: c.id,
              question: c.title
            })
          }
        />
      ))}
    </span>
  )
}

function SegmentList({ sourceId, segs }: { sourceId: string; segs: Segment[] }) {
  const highlight = useApp((s) => s.highlight)
  const ref = useRef<HTMLElement>(null)
  const onSelect = useSourceSelection(sourceId)
  const { data: threads = [] } = useQuery({
    queryKey: ['threads', sourceId],
    queryFn: () => api.chat.threads(sourceId).then((list) => list.filter((c) => c.anchor?.parentType === 'source'))
  })
  // 批注高亮
  const annotations = useAnnotations('source', sourceId)
  useTextHighlights(`source:${sourceId}`, ref, annotations, segs)
  // AI 引用跳转：定位并高亮片段
  useEffect(() => {
    if (highlight?.type !== 'segment') return
    const page = /page=(\d+)/.exec(highlight.locator ?? '')?.[1]
    const el =
      ref.current?.querySelector<HTMLElement>(`[data-segment="${highlight.id}"]`) ??
      (page ? ref.current?.querySelector<HTMLElement>(`[data-page="${page}"]`) : null)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('is-flash')
    setTimeout(() => el.classList.remove('is-flash'), 2200)
    useApp.getState().setHighlight(null)
  }, [highlight, segs])
  return (
    <article ref={ref} className="source-text select-text" onMouseUp={onSelect} onKeyUp={onSelect}>
      {segs.map((s: Segment) =>
        s.kind === 'heading' ? (
          <h3 key={s.id} {...segAttrs(s)}>
            <ThreadMarks threads={threads} segId={s.id} />
            {s.text.replace(/^#+\s*/, '')}
          </h3>
        ) : s.kind === 'code' ? (
          <pre key={s.id} {...segAttrs(s)}>
            {s.text.replace(/^`{3,}[^\n]*\n/, '').replace(/\n`{3,}$/, '')}
          </pre>
        ) : (
          <p key={s.id} {...segAttrs(s)}>
            <ThreadMarks threads={threads} segId={s.id} />
            {s.text}
          </p>
        )
      )}
    </article>
  )
}

function Centered({ icon, text }: { icon: React.ReactNode; text?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-sm text-subtle [&_svg]:size-6">
      {icon}
      {text && <p className="max-w-[300px] leading-relaxed">{text}</p>}
    </div>
  )
}

/** 图片资料：图片 + 识别出的文字（可选中提问） */
function ImageSource({ source }: { source: Source }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data: segs = [] } = useQuery({ queryKey: ['segments', source.id], queryFn: () => api.segments.list(source.id) })
  useEffect(
    () =>
      window.jiweiEvents.on('segments:changed', (p) => {
        if (p.sourceId === source.id) void qc.invalidateQueries({ queryKey: ['segments', source.id] })
      }),
    [qc, source.id]
  )
  if (!segs.length)
    return (
      <div className="flex h-full items-center justify-center p-6">
        <img src={source.assetUrl!} alt={source.title} className="max-h-full max-w-full rounded-lg object-contain shadow-card" />
      </div>
    )
  return (
    <div className="space-y-5 p-6">
      <img src={source.assetUrl!} alt={source.title} className="mx-auto max-h-[60vh] max-w-full rounded-lg object-contain shadow-card" />
      <section aria-label={t('workspace.recog.imageText')}>
        <h4 className="mb-2 text-xs font-medium text-muted">{t('workspace.recog.imageText')}</h4>
        <SegmentList sourceId={source.id} segs={segs} />
      </section>
    </div>
  )
}

/** 解析为文本分段后在应用内阅读的格式 */
const TEXT_EXTS = Object.keys(FORMATS).filter((ext) => !!FORMATS[ext].parser && ext !== 'pdf')

function Body({ source }: { source: Source }) {
  const { t } = useTranslation()
  const ext = source.originalName?.split('.').pop()?.toLowerCase() ?? ''
  if (source.kind === 'image' && source.assetUrl) return <ImageSource source={source} />
  if (
    (source.kind === 'video' || source.kind === 'audio' || source.kind === 'recording') &&
    (source.assetUrl || source.kind === 'recording')
  )
    return <MediaPane source={source} />
  if (source.kind === 'pdf' && source.assetUrl) return <PdfViewer source={source} />
  if (TEXT_EXTS.includes(ext) || source.kind === 'web') return <TextSegments source={source} />
  return <Centered icon={<FileQuestion />} text={t('workspace.unsupported')} />
}

/** 检索准备情况（v0.7.6）：让用户看得见资料已进入知识库、语义索引建到哪里 */
function IndexChip({ sourceId, conversationId = null }: { sourceId: string; conversationId?: string | null }) {
  const { t } = useTranslation()
  const { data: s } = useQuery({
    queryKey: ['source', sourceId, 'index', conversationId],
    queryFn: () => api.sources.indexStatus(sourceId, conversationId),
    refetchInterval: (q) => (q.state.data && q.state.data.semantic && q.state.data.embedded < q.state.data.indexable ? 4000 : false)
  })
  if (!s || !s.segments) return null
  const pct = s.indexable ? Math.floor((s.embedded / s.indexable) * 100) : 100
  const label = !s.semantic ? t('workspace.index.off') : pct >= 98 ? t('workspace.index.ready') : t('workspace.index.building', { pct })
  return (
    <Tip
      label={s.semantic ? t('workspace.index.hint', { done: s.embedded, total: s.indexable }) : t('workspace.index.hintOff')}
      side="bottom"
    >
      <span className="no-drag" data-testid="source-index">
        {' · '}
        <span className={cn(s.semantic && pct >= 98 ? 'text-accent' : 'text-subtle')}>{label}</span>
      </span>
    </Tip>
  )
}

export function SourcePane({ sourceId }: { sourceId: string }) {
  const { t } = useTranslation()
  const openSource = useApp((s) => s.openSource)
  const conversationId = useApp((s) => s.sourceConversationId)
  const { data: readiness } = useReadinessMany([sourceId], conversationId)
  const { data: source } = useQuery({ queryKey: ['source', sourceId], queryFn: () => api.sources.get(sourceId) })
  const annotations = useAnnotations('source', sourceId)
  const [showAnnotations, setShowAnnotations] = useState(false)
  if (!source) return <div className="h-full bg-sunken" />
  return (
    <div className="@container flex h-full flex-col bg-sunken/50">
      <header className="drag flex min-h-[52px] shrink-0 flex-wrap items-center gap-2.5 border-b border-border/70 px-4 py-1">
        <span data-tint={KIND_TINT[source.kind]} className="tint grid size-7 shrink-0 place-items-center rounded-lg [&_svg]:size-4">
          {KIND_ICON[source.kind]}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg" title={source.title}>
            {source.title}
          </p>
          <p className="truncate text-2xs text-subtle">
            {t(`library.kinds.${source.kind}`)}
            {source.size ? ` · ${formatBytes(source.size)}` : ''}
            {source.author ? ` · ${source.author}` : ''}
            <IndexChip sourceId={source.id} conversationId={conversationId} />
          </p>
        </div>
        <div className="no-drag flex items-center gap-0.5">
          {!source.aiExcluded && ['pdf', 'web', 'book', 'document', 'other'].includes(source.kind) && (
            <ReadingControls target={{ kind: 'source', id: source.id }} />
          )}
          {source.kind === 'web' && source.url && (
            <Tip label={t('browser.openOriginal')} side="bottom">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('browser.openOriginal')}
                onClick={() => useApp.getState().openBrowser(source.url!)}
              >
                <Globe />
              </Button>
            </Tip>
          )}
          <Tip label={t('annotate.panel')} side="bottom">
            <Button
              variant={showAnnotations ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 px-2"
              aria-pressed={showAnnotations}
              aria-label={t('annotate.panelCount', { count: annotations.length })}
              onClick={() => setShowAnnotations(!showAnnotations)}
            >
              <Highlighter />
              {annotations.length > 0 && <span className="tabular-nums">{annotations.length}</span>}
            </Button>
          </Tip>
          <Tip label={t('workspace.openExternal')} side="bottom">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void api.sources.open(source.id)}
              aria-label={t('workspace.openExternal')}
            >
              <ExternalLink />
            </Button>
          </Tip>
          <Tip label={t('workspace.closeSource')} side="bottom">
            <Button variant="ghost" size="icon-sm" onClick={() => openSource(null)} aria-label={t('workspace.closeSource')}>
              <X />
            </Button>
          </Tip>
        </div>
      </header>
      {source.kind === 'pdf' || source.kind === 'image' ? (
        <RecognitionBar sourceId={source.id} readiness={readiness?.[sourceId]} conversationId={conversationId} />
      ) : (
        <ReadinessBanner key={sourceId} sourceId={sourceId} readiness={readiness?.[sourceId]} conversationId={conversationId} />
      )}
      <div className="relative min-h-0 flex-1">
        <div className={cn('h-full overflow-auto')} data-reading-scroll>
          <Body source={source} />
        </div>
        {showAnnotations && (
          <AnnotationsPanel sourceId={source.id} isPdf={source.kind === 'pdf'} onClose={() => setShowAnnotations(false)} />
        )}
      </div>
    </div>
  )
}
