import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as pdfjs from 'pdfjs-dist'
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import 'pdfjs-dist/web/pdf_viewer.css'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { Loader2, ZoomIn, ZoomOut, SquareDashedMousePointer } from 'lucide-react'
import { scanTextLayout } from '@shared/scanText'
import type { Anchor } from '@shared/context'
import type { Annotation, Conversation, Segment, Source } from '@shared/types'
import { api, cn } from '@/lib/utils'
import { useApp } from '@/store/app'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/primitives'
import { useAssist, type Rect } from '../assist/store'
import { useAnnotate, useAnnotations } from '../annotate/store'
import { useReadingState } from '../reading/ReadingControls'
import { ReadingSourceText } from '../reading/ReadingText'
import { originalRangeText } from '@shared/reading'
import { paintSourceRange } from './sourceRange'
import { toast } from 'sonner'

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
    if (p && (!m.has(Number(p[1])) || s.kind === 'ocr:scan')) m.set(Number(p[1]), s.id)
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

/** 选区在页内的相对矩形：同一行的片段合并为一个（高亮批注用） */
function lineRects(page: HTMLElement, range: Range): Rect[] {
  const b = page.getBoundingClientRect()
  const lines: DOMRect[] = []
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue
    // 只取本页内的部分
    if (r.bottom < b.top || r.top > b.bottom) continue
    const same = lines.find((l) => Math.abs(l.top - r.top) < r.height * 0.5 && Math.abs(l.height - r.height) < r.height * 0.6)
    if (same) {
      const left = Math.min(same.left, r.left)
      const right = Math.max(same.right, r.right)
      same.x = left
      same.width = right - left
    } else lines.push(DOMRect.fromRect(r))
  }
  return lines.slice(0, 200).map((l) => {
    const r = relRect(page, l)
    return { x: r.x, y: r.y, w: r.w, h: r.h }
  })
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
  const activeRange = useRef<(() => void) | null>(null)
  useEffect(() => () => activeRange.current?.(), [source.id])
  const qc = useQueryClient()
  const { data: scanPages = [] } = useQuery({ queryKey: ['scan-pages', source.id], queryFn: () => api.recognition.scanPages(source.id) })
  const { data: segs = [] } = useQuery({ queryKey: ['segments', source.id], queryFn: () => api.segments.list(source.id) })
  const { data: reading } = useReadingState({ kind: 'source', id: source.id })
  const readingActive = !!reading?.foreign && (reading.mode !== 'original' || reading.annotations)
  const { data: threads = [] } = useQuery({
    queryKey: ['threads', source.id],
    queryFn: () => api.chat.threads(source.id).then((list) => list.filter((c) => c.anchor?.parentType === 'source'))
  })
  const segRef = useRef(segs)
  segRef.current = segs
  const annotations = useAnnotations('source', source.id)
  const annRef = useRef(annotations)
  annRef.current = annotations

  // 加载文档
  useEffect(() => {
    const el = container.current
    if (!el || !source.assetUrl) return
    let destroyed = false
    setState('loading')
    const eventBus = new EventBus()
    const linkService = new PDFLinkService({ eventBus })
    const viewer = new PDFViewer({ container: el, eventBus, linkService, textLayerMode: 1, removePageBorders: true })
    linkService.setViewer(viewer)
    viewerRef.current = viewer
    eventBus.on('pagesinit', () => {
      if (destroyed) return
      viewer.currentScaleValue = 'page-width'
      setState('ready')
      setContext({ sourceLocator: 'page=1' })
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
        // CCITT/JBIG2 scan images also need the decoder in the renderer's PDF worker.
        // Use bundled resources through the app protocol on every OS, including inside ASAR.
        task = pdfjs.getDocument({ data, wasmUrl: 'jiwei://pdfjs/wasm/', useWorkerFetch: false })
        const doc = await task.promise
        if (destroyed) return void task.destroy()
        viewer.setDocument(doc)
        linkService.setDocument(doc)
        setPages(doc.numPages)
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

  useEffect(
    () =>
      window.jiweiEvents.on('recognition:source', (p) => {
        if (p.sourceId === source.id) {
          void qc.invalidateQueries({ queryKey: ['scan-pages', source.id] })
          void qc.invalidateQueries({ queryKey: ['segments', source.id] })
        }
      }),
    [qc, source.id]
  )

  // 保留 pdf.js 的文字层结构；页面重绘、缩放和 OCR 更新后按当前尺寸重建。
  useEffect(() => {
    const el = container.current
    if (!el || state !== 'ready') return
    const place = (): void => {
      for (const page of scanPages) {
        const pg = el.querySelector<HTMLElement>(`.page[data-page-number="${page.page}"]`)
        if (!pg?.querySelector('.canvasWrapper')) continue
        const w = pg.clientWidth,
          h = pg.clientHeight
        const version = `${w}:${h}:${JSON.stringify(page.blocks)}`
        const old = pg.querySelector<HTMLElement>('.ocrTextLayer')
        if (old?.dataset.version === version) continue
        old?.remove()
        const layer = document.createElement('div')
        layer.className = 'textLayer ocrTextLayer'
        layer.dataset.version = version
        Object.assign(layer.style, { position: 'absolute', inset: '0', zIndex: '2' })
        const groups = new Map<number, HTMLElement>()
        for (const line of scanTextLayout(page.blocks, w, h)) {
          let group = groups.get(line.block)
          if (!group) {
            group = document.createElement('div')
            const box = page.blocks[line.block].box
            Object.assign(group.style, {
              position: 'absolute',
              left: `${(box[0] * w) / 1000}px`,
              top: `${(box[1] * h) / 1000}px`,
              width: `${((box[2] - box[0]) * w) / 1000}px`,
              height: `${((box[3] - box[1]) * h) / 1000}px`,
              pointerEvents: 'none',
              transform: 'none'
            })
            layer.appendChild(group)
            groups.set(line.block, group)
          }
          const span = document.createElement('span')
          span.textContent = line.text
          Object.assign(span.style, {
            position: 'absolute',
            color: 'transparent',
            whiteSpace: 'pre',
            cursor: 'text',
            pointerEvents: 'auto',
            userSelect: 'text',
            left: '0',
            top: `${line.top - (page.blocks[line.block].box[1] * h) / 1000}px`,
            width: `${line.width}px`,
            height: `${line.height}px`,
            fontSize: `${line.fontSize}px`,
            lineHeight: `${line.height}px`,
            transform: 'none'
          })
          group.appendChild(span)
          group.appendChild(document.createElement('br'))
        }
        pg.appendChild(layer)
      }
    }
    place()
    const observer = new MutationObserver(place)
    observer.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
    const resize = new ResizeObserver(place)
    resize.observe(el)
    return () => {
      observer.disconnect()
      resize.disconnect()
      el.querySelectorAll('.ocrTextLayer').forEach((x) => x.remove())
    }
  }, [scanPages, state])

  // AI 引用 / 出处链接：跳到对应页并闪烁
  useEffect(() => {
    const v = viewerRef.current
    if (
      !highlight ||
      highlight.type !== 'segment' ||
      (highlight.sourceId && highlight.sourceId !== source.id) ||
      state !== 'ready' ||
      !v?.pagesCount
    )
      return
    let p = highlight.selector?.page ?? Number(highlight.locator?.match(/page=(\d+)/)?.[1] ?? 0)
    if (!p && highlight.id) for (const [n, id] of pageSegments(segs)) if (id === highlight.id) p = n
    if (!p || p > v.pagesCount) return
    activeRange.current?.()
    activeRange.current = null
    v.currentPageNumber = p
    let cancelled = false
    const current = () => !cancelled && useApp.getState().highlight === highlight
    const consume = () => {
      if (current()) useApp.getState().setHighlight(null)
    }
    const paint = (): boolean => {
      const root = container.current?.querySelector<HTMLElement>('.pdfViewer')
      if (!current() || !root) return false
      if (highlight.selector?.quote) {
        const clear = paintSourceRange(root, highlight.selector)
        if (!clear) return false
        activeRange.current = clear
      } else {
        const el = root.querySelector<HTMLElement>(`.page[data-page-number="${p}"]`)
        if (!el) return false
        el.classList.add('is-flash')
        setTimeout(() => el.classList.remove('is-flash'), 2200)
      }
      consume()
      return true
    }
    const rendered = (event: { pageNumber: number }) => {
      if (paint() || !current()) return
      if (event.pageNumber === (highlight.selector?.pageEnd ?? p)) {
        toast.info(t('annotate.orphan'))
        consume()
      }
    }
    v.eventBus.on('textlayerrendered', rendered)
    const observer = new MutationObserver(() => {
      paint()
    })
    if (container.current) observer.observe(container.current, { childList: true, subtree: true })
    const frame = requestAnimationFrame(() => {
      paint()
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      v.eventBus.off('textlayerrendered', rendered)
    }
  }, [highlight, state, segs, source.id, t])

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

  // 批注高亮层：每页一层（页面重新渲染后补上）
  useEffect(() => {
    const el = container.current
    if (!el || state !== 'ready') return
    const byPage = new Map<number, Annotation[]>()
    for (const a of annotations)
      if (a.selector.page && a.selector.rects?.length) byPage.set(a.selector.page, [...(byPage.get(a.selector.page) ?? []), a])
    const fill = (pg: HTMLElement, list: Annotation[]): void => {
      const layer = document.createElement('div')
      layer.className = 'jw-anno-layer'
      layer.dataset.version = String(annotations.length)
      for (const a of list) {
        for (const r of a.selector.rects!) {
          const d = document.createElement('div')
          d.className = 'jw-anno-rect'
          d.dataset.id = a.id
          d.dataset.color = a.color ?? 'yellow'
          if (a.motivation === 'questioning') d.dataset.question = '1'
          Object.assign(d.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` })
          layer.appendChild(d)
        }
        // 有评论：首行右上角的气泡
        if (a.body?.trim()) {
          const first = a.selector.rects![0]
          const n = document.createElement('button')
          n.className = 'jw-anno-note'
          n.textContent = a.motivation === 'questioning' ? '?' : '…'
          n.title = a.body
          n.setAttribute('aria-label', t('annotate.open', { text: a.body.slice(0, 40) }))
          Object.assign(n.style, { left: `${(first.x + first.w) * 100}%`, top: `${first.y * 100}%` })
          n.onmousedown = (e) => e.stopPropagation()
          n.onclick = (e) => {
            e.stopPropagation()
            const b = (e.currentTarget as HTMLElement).getBoundingClientRect()
            useAnnotate.getState().open({
              id: a.id,
              targetType: 'source',
              targetId: source.id,
              rect: { x: b.left, y: b.top, w: b.width, h: b.height },
              edit: false
            })
          }
          layer.appendChild(n)
        }
      }
      // 放在文字层之下：不妨碍选中文字
      const text = pg.querySelector('.textLayer')
      if (text) pg.insertBefore(layer, text)
      else pg.appendChild(layer)
    }
    const place = (): void => {
      el.querySelectorAll('.jw-anno-layer').forEach((d) => d.remove())
      for (const [p, list] of byPage) {
        const pg = el.querySelector<HTMLElement>(`.page[data-page-number="${p}"]`)
        if (pg?.querySelector('.canvasWrapper')) fill(pg, list)
      }
    }
    place()
    const obs = new MutationObserver(() => {
      for (const p of byPage.keys()) {
        const pg = el.querySelector<HTMLElement>(`.page[data-page-number="${p}"]`)
        if (pg?.querySelector('.canvasWrapper') && !pg.querySelector('.jw-anno-layer')) fill(pg, byPage.get(p)!)
      }
    })
    obs.observe(el, { childList: true, subtree: true })
    return () => {
      obs.disconnect()
      el.querySelectorAll('.jw-anno-layer').forEach((d) => d.remove())
    }
  }, [annotations, state, source.id, t])

  /** 点在高亮上：打开批注卡片 */
  const hitAnnotation = (x: number, y: number): boolean => {
    const pg = document.elementsFromPoint(x, y).map(pageOf).find(Boolean)
    if (!pg) return false
    const n = Number(pg.dataset.pageNumber)
    const b = pg.getBoundingClientRect()
    const px = (x - b.left) / b.width
    const py = (y - b.top) / b.height
    const a = annRef.current.find(
      (a) => a.selector.page === n && a.selector.rects?.some((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h)
    )
    if (!a) return false
    const r = a.selector.rects![0]
    useAnnotate.getState().open({
      id: a.id,
      targetType: 'source',
      targetId: source.id,
      rect: { x: b.left + r.x * b.width, y: b.top + r.y * b.height, w: r.w * b.width, h: r.h * b.height },
      edit: false
    })
    return true
  }

  // 选中文字 → 浮条；单击高亮 → 批注卡片
  const onMouseUp = (e: React.MouseEvent): void => {
    if (regionMode) return
    const { clientX, clientY } = e
    requestAnimationFrame(() => {
      const sel = window.getSelection()
      const quote = sel?.rangeCount ? originalRangeText(sel.getRangeAt(0)).replace(/\s+/g, ' ').trim() : ''
      if (!sel || !quote || !sel.rangeCount) {
        setContext({ sourceSelection: null })
        useAssist.getState().showToolbar(null)
        hitAnnotation(clientX, clientY)
        return
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
      useAssist
        .getState()
        .showToolbar({ anchor, rect: { x: b.left, y: b.top, w: b.width, h: b.height }, ...(pg ? { rects: lineRects(pg, range) } : {}) })
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
        <div
          ref={container}
          onMouseUp={onMouseUp}
          className={cn('pdf-container absolute inset-0 overflow-auto', readingActive && 'invisible pointer-events-none')}
          data-testid="pdf-viewer"
        >
          <div className="pdfViewer" />
        </div>
        {readingActive && (
          <div className="absolute inset-0 min-w-0 overflow-auto" data-reading-scroll>
            <ReadingSourceText sourceId={source.id} segments={segs} pdf />
          </div>
        )}
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
