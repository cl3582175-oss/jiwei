import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { X, ExternalLink, Loader2, FileQuestion } from 'lucide-react'
import type { Segment, Source } from '@shared/types'
import { api, cn, formatBytes } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { KIND_ICON } from '../library/LibraryView'
import { KIND_TINT } from '@/lib/tint'

// 工作区左栏：在应用内查看资料，并把“看到哪里 / 选中了什么”同步到工作区上下文。

function TextSegments({ source }: { source: Source }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const setContext = useApp((s) => s.setContext)
  const { data: segs, isFetched } = useQuery({ queryKey: ['segments', source.id], queryFn: () => api.segments.list(source.id) })
  useEffect(
    () =>
      window.jiweiEvents.on('segments:changed', (p) => {
        if (p.sourceId === source.id) void qc.invalidateQueries({ queryKey: ['segments', source.id] })
      }),
    [qc, source.id]
  )
  const onSelect = (): void => {
    const sel = window.getSelection()
    const text = sel?.toString().trim() ?? ''
    const el = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement
    const segId = el?.closest<HTMLElement>('[data-segment]')?.dataset.segment ?? null
    setContext({ sourceSelection: text ? text.slice(0, 4000) : null, sourceSegmentId: segId })
  }
  if (!isFetched) return <Centered icon={<Loader2 className="animate-spin" />} />
  if (!segs?.length) return <Centered icon={<Loader2 className="animate-spin" />} text={t('workspace.parsing')} />
  return <SegmentList segs={segs} onSelect={onSelect} />
}

function SegmentList({ segs, onSelect }: { segs: Segment[]; onSelect: () => void }) {
  const highlight = useApp((s) => s.highlight)
  const ref = useRef<HTMLElement>(null)
  // AI 引用跳转：定位并高亮片段
  useEffect(() => {
    if (highlight?.type !== 'segment') return
    const el = ref.current?.querySelector<HTMLElement>(`[data-segment="${highlight.id}"]`)
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
          <h3 key={s.id} data-segment={s.id}>
            {s.text.replace(/^#+\s*/, '')}
          </h3>
        ) : s.kind === 'code' ? (
          <pre key={s.id} data-segment={s.id}>
            {s.text.replace(/^```\w*\n?|```$/g, '')}
          </pre>
        ) : (
          <p key={s.id} data-segment={s.id}>
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

function Media({ source }: { source: Source }) {
  const setContext = useApp((s) => s.setContext)
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const onTime = (): void => {
    const t = ref.current?.currentTime ?? 0
    setContext({ sourceLocator: `t=${Math.floor(t)}` })
  }
  const props = { ref, src: source.assetUrl!, controls: true, onTimeUpdate: onTime, onSeeked: onTime }
  return source.kind === 'video' ? (
    <div className="flex h-full items-center bg-black">
      <video {...props} className="max-h-full w-full" />
    </div>
  ) : (
    <div className="flex h-full items-center justify-center p-8">
      <audio {...props} className="w-full" />
    </div>
  )
}

/** 内置 PDF 查看器；AI 引用带页码时跳到对应页 */
function PdfFrame({ source }: { source: Source }) {
  const highlight = useApp((s) => s.highlight)
  const [page, setPage] = useState<string | null>(null)
  useEffect(() => {
    const m = highlight?.type === 'segment' ? highlight.locator?.match(/page=(\d+)/) : null
    if (m) {
      setPage(m[1])
      useApp.getState().setHighlight(null)
    }
  }, [highlight])
  return (
    <iframe
      key={page ?? 'p'}
      title={source.title}
      src={`${source.assetUrl}${page ? `#page=${page}` : ''}`}
      className="h-full w-full border-0 bg-surface"
    />
  )
}

/** 解析为文本分段后在应用内阅读的格式 */
const TEXT_EXTS = ['md', 'markdown', 'txt', 'docx', 'epub', 'html', 'htm']

function Body({ source }: { source: Source }) {
  const { t } = useTranslation()
  const ext = source.originalName?.split('.').pop()?.toLowerCase() ?? ''
  if (source.kind === 'image' && source.assetUrl)
    return (
      <div className="flex h-full items-center justify-center p-6">
        <img src={source.assetUrl} alt={source.title} className="max-h-full max-w-full rounded-lg object-contain shadow-card" />
      </div>
    )
  if ((source.kind === 'video' || source.kind === 'audio') && source.assetUrl) return <Media source={source} />
  if (source.kind === 'pdf' && source.assetUrl) return <PdfFrame source={source} />
  if (TEXT_EXTS.includes(ext) || source.kind === 'web') return <TextSegments source={source} />
  return <Centered icon={<FileQuestion />} text={t('workspace.unsupported')} />
}

export function SourcePane({ sourceId }: { sourceId: string }) {
  const { t } = useTranslation()
  const openSource = useApp((s) => s.openSource)
  const { data: source } = useQuery({ queryKey: ['source', sourceId], queryFn: () => api.sources.get(sourceId) })
  if (!source) return <div className="h-full bg-sunken" />
  return (
    <div className="flex h-full flex-col bg-sunken/50">
      <header className="drag flex h-[52px] shrink-0 items-center gap-2.5 border-b border-border/70 px-4">
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
          </p>
        </div>
        <div className="no-drag flex items-center gap-0.5">
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
      <div className={cn('min-h-0 flex-1 overflow-auto')}>
        <Body source={source} />
      </div>
    </div>
  )
}
