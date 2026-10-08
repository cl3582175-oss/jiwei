import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import * as pdfjs from 'pdfjs-dist'
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import 'pdfjs-dist/web/pdf_viewer.css'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { Loader2, ZoomIn, ZoomOut, SquareDashedMousePointer } from 'lucide-react'
import type { Anchor } from '@shared/context'
import type { Conversation, Segment, Source } from '@shared/types'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { useAssist, type Rect } from '../assist/store'

// PDF 阅读：pdf.js 自带的查看器（文字层可选中、可定位）。
//   - 翻页 → 工作区上下文（page=N）；AI 引用 / 出处链接 → 跳到对应页并闪烁
//   - 选中文字 → 选区浮条（锚点带页码、页内位置）
//   - 框选 → 截取区域图像 + 区域内文字，就地提问
//   - 就地提问在页面边缘留下标记

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** 页码 → 该页的片段 ID（PDF 按页分段） */
function pageSegments(segs: Segment[]): Map<number, string> {
  const m = new Map<number, string>()
  for (const s of segs) {
    const p = String((s.locator as { value?: unknown }).value ?? '').match(/page=(\d+)/)
    if (p && !m.has(Number(p[1]))) m.set(Number(p[1]), s.id)
  }
  return m
}

const pageOf = (el: Element | null): HTMLElement | null => el?.closest<HTMLElement>('.page[data-page-number]') ?? null

/** 相对页面的位置（0–1），缩放后仍然准确 */
function relRect(page: HTMLElement, r: DOMRect | Rect): NonNullable<Anchor['rect']> {
  const b = page.getBoundingClientRect()
  const x = 'left' in r ? r.left : r.x
  const y = 'top' in r ? r.top : r.y
  const w = 'width' in r ? r.width : r.w
  const h = 'height' in r ? r.height : r.h
  return { x: (x - b.left) / b.width, y: (y - b.top) / b.height, w: w / b.width, h: h / b.height }
}

export function PdfViewer({ source }: { source: Source }) {
  const { t } = useTranslation()
  const container = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<PDFViewer | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(0)
  const [regionMode, setRegionMode] = useState(false)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const setContext = useApp((s) => s.setContext)
  const highlight = useApp((s) => s.highlight)
  const { data: segs = [] } = useQuery({ queryKey: ['segments', source.id], queryFn: () => api.segments.list(source.id) })
  const { data: threads = [] } = useQuery({ queryKey: ['threads', source.id], queryFn: () => api.chat.threads(source.id) })
  const segRef = useRef(segs)
  segRef.current = segs

  // 加载文档
  useEffect(() => {
    const el = container.current
    if (!el || !source.assetUrl) return
    let destroyed = false
    const eventBus = new EventBus()
    const linkService = new PDFLinkService({ eventBus })
    const viewer = new PDFViewer({ container: el, eventBus, linkService, textLayerMode: 1, removePageBorders: true })
    linkService.setViewer(viewer)
    viewerRef.current = viewer
    eventBus.on('pagesinit', () => {
      viewer.currentScaleValue = 'page-width'
    })
    eventBus.on('pagechanging', (e: { pageNumber: number }) => {
      setPage(e.pageNumber)
      setContext({ sourceLocator: `page=${e.pageNumber}`, sourceSegmentId: pageSegments(segRef.current).get(e.pageNumber) ?? null })
    })
    let task: ReturnType<typeof pdfjs.getDocument> | null = null
    void (async () => {
      try {
        // 一次读入（素材协议不支持跨源 Range 预检）
        const data = new Uint8Array(await (await fetch(source.assetUrl!)).arrayBuffer())
        if (destroyed) return
        task = pdfjs.getDocument({ data })
        const doc = await task.promise
        if (destroyed) return void task.destroy()
        viewer.setDocument(doc)
        linkService.setDocument(doc)
        setPages(doc.numPages)
        setState('ready')
        setContext({ sourceLocator: 'page=1' })
      } catch (e) {
        if (!destroyed) {
          console.error('[pdf]', e)
          setState('error')
        }
      }
    })()
    const onResize = new ResizeObserver(() => {
      if (viewer.pdfDocument) viewer.currentScaleValue = viewer.currentScaleValue || 'page-width'
    })
    onResize.observe(el)
    return () => {
      destroyed = true
      onResize.disconnect()
      void task?.destroy()
      viewer.cleanup()
      viewerRef.current = null
    }
  }, [source.assetUrl, setContext])

  // AI 引用 / 出处链接：跳到对应页并闪烁
  useEffect(() => {
    const v = viewerRef.current
    if (!highlight || highlight.type !== 'segment' || state !== 'ready' || !v) return
    let p = Number(highlight.locator?.match(/page=(\d+)/)?.[1] ?? 0)
    if (!p && highlight.id) for (const [n, id] of pageSegments(segs)) if (id === highlight.id) p = n
    if (!p) return
    v.currentPageNumber = p
    requestAnimationFrame(() => {
      const el = container.current?.querySelector<HTMLElement>(`.page[data-page-number="${p}"]`)
      el?.classList.add('is-flash')
      setTimeout(() => el?.classList.remove('is-flash'), 2200)
    })
    useApp.getState().setHighlight(null)
  }, [highlight, state, segs])

  // 页面边缘的就地提问标记（页面渲染后插入）
  useEffect(() => {
    const el = container.current
    if (!el || state !== 'ready') return
    const place = (): void => {
      el.querySelectorAll('.pdf-thread-dot').forEach((d) => d.remove())
      for (const c of threads as Conversation[]) {
        const a = c.anchor
        if (!a?.page) continue
        const pg = el.querySelector<HTMLElement>(`.page[data-page-number="${a.page}"]`)
        if (!pg) continue
        const dot = document.createElement('button')
        dot.className = 'thread-dot pdf-thread-dot'
        dot.title = c.title
        dot.setAttribute('aria-label', t('assist.thread', { title: c.title }))
        dot.style.top = `${((a.rect?.y ?? 0.02) * 100).toFixed(2)}%`
        dot.onclick = (e) =>
          useAssist.getState().openCard({
            anchor: a,
            rect: (e.currentTarget as HTMLElement).getBoundingClientRect() as unknown as Rect,
            action: 'ask',
            conversationId: c.id,
            question: c.title
          })
        pg.appendChild(dot)
      }
    }
    place()
    const obs = new MutationObserver(() => {
      if (threads.length && !el.querySelector('.pdf-thread-dot')) place()
    })
    obs.observe(el, { childList: true, subtree: true })
    return () => obs.disconnect()
  }, [threads, state, t])

  // 选中文字 → 浮条
  const onMouseUp = (): void => {
    if (regionMode) return
    requestAnimationFrame(() => {
      const sel = window.getSelection()
      const quote = sel?.toString().replace(/\s+/g, ' ').trim() ?? ''
      if (!sel || !quote || !sel.rangeCount) {
        setContext({ sourceSelection: null })
        return useAssist.getState().showToolbar(null)
      }
      const range = sel.getRangeAt(0)
      const pg = pageOf(range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement)
      const n = Number(pg?.dataset.pageNumber ?? page)
      const b = range.getBoundingClientRect()
      const anchor: Anchor = {
        kind: 'source-text',
        parentType: 'source',
        parentId: source.id,
        ownerId: pageSegments(segs).get(n) ?? null,
        quote: quote.slice(0, 8000),
        page: n,
        ...(pg ? { rect: relRect(pg, b) } : {})
      }
      setContext({ sourceSelection: quote.slice(0, 4000), sourceSegmentId: anchor.ownerId ?? null, sourceLocator: `page=${n}` })
      useAssist.getState().showToolbar({ anchor, rect: { x: b.left, y: b.top, w: b.width, h: b.height } })
    })
  }

  // 框选：截取区域图像与区域内文字
  const finishRegion = (): void => {
    const d = drag
    setDrag(null)
    setRegionMode(false)
    if (!d || Math.abs(d.x1 - d.x0) < 12 || Math.abs(d.y1 - d.y0) < 12) return
    const r = { x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1), w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) }
    const hit = document.elementsFromPoint(r.x + r.w / 2, r.y + r.h / 2)
    const pg = hit.map(pageOf).find(Boolean)
    const canvas = pg?.querySelector('canvas')
    if (!pg || !canvas) return
    const cb = canvas.getBoundingClientRect()
    const sx = canvas.width / cb.width
    const sy = canvas.height / cb.height
    const out = document.createElement('canvas')
    const max = 1600
    const k = Math.min(1, max / Math.max(r.w * sx, r.h * sy))
    out.width = Math.round(r.w * sx * k)
    out.height = Math.round(r.h * sy * k)
    out.getContext('2d')!.drawImage(canvas, (r.x - cb.left) * sx, (r.y - cb.top) * sy, r.w * sx, r.h * sy, 0, 0, out.width, out.height)
    const image = out.toDataURL('image/png')
    // 区域内的文字（文字层中与区域相交的片段）
    const text = [...pg.querySelectorAll<HTMLElement>('.textLayer span')]
      .filter((s) => {
        const b = s.getBoundingClientRect()
        return b.right > r.x && b.left < r.x + r.w && b.bottom > r.y && b.top < r.y + r.h
      })
      .map((s) => s.textContent)
      .join('')
      .trim()
    const n = Number(pg.dataset.pageNumber)
    const anchor: Anchor = {
      kind: 'region',
      parentType: 'source',
      parentId: source.id,
      ownerId: pageSegments(segs).get(n) ?? null,
      quote: text.slice(0, 4000) || undefined,
      page: n,
      rect: relRect(pg, r)
    }
    useAssist.getState().openCard({ anchor, rect: r, action: 'ask', conversationId: null, question: '', image })
  }

  const zoom = (f: number): void => {
    const v = viewerRef.current
    if (v) v.currentScale = Math.min(4, Math.max(0.4, v.currentScale * f))
  }

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-3 text-xs text-muted">
        <span className="tabular-nums" aria-label={t('assist.pageOf', { n: page, total: pages })}>
          {pages ? `${page} / ${pages}` : ''}
        </span>
        <span className="flex-1" />
        <Tip label={t('assist.regionHint')} side="bottom">
          <Button
            size="sm"
            variant={regionMode ? 'primary' : 'ghost'}
            className="h-7"
            aria-pressed={regionMode}
            onClick={() => setRegionMode(!regionMode)}
          >
            <SquareDashedMousePointer />
            {t('assist.region')}
          </Button>
        </Tip>
        <Button size="icon-sm" variant="ghost" aria-label={t('assist.zoomOut')} onClick={() => zoom(1 / 1.15)}>
          <ZoomOut />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label={t('assist.zoomIn')} onClick={() => zoom(1.15)}>
          <ZoomIn />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={container} onMouseUp={onMouseUp} className="pdf-container absolute inset-0 overflow-auto" data-testid="pdf-viewer">
          <div className="pdfViewer" />
        </div>
        {regionMode && (
          <div
            className="absolute inset-0 z-10 cursor-crosshair"
            onMouseDown={(e) => setDrag({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY })}
            onMouseMove={(e) => drag && setDrag({ ...drag, x1: e.clientX, y1: e.clientY })}
            onMouseUp={finishRegion}
            onWheel={(e) => container.current?.scrollBy(0, e.deltaY)}
          >
            {drag && (
              <div
                className="pointer-events-none fixed border-2 border-dashed border-accent bg-accent/10"
                style={{
                  left: Math.min(drag.x0, drag.x1),
                  top: Math.min(drag.y0, drag.y1),
                  width: Math.abs(drag.x1 - drag.x0),
                  height: Math.abs(drag.y1 - drag.y0)
                }}
              />
            )}
          </div>
        )}
        {state !== 'ready' && (
          <div
            className={cn('absolute inset-0 grid place-items-center text-sm text-subtle', state === 'loading' && '[&_svg]:animate-spin')}
          >
            {state === 'loading' ? <Loader2 className="size-6" /> : t('assist.pdfError')}
          </div>
        )}
      </div>
    </div>
  )
}
