import { readFile } from 'fs/promises'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { createCanvas, DOMMatrix, ImageData, Path2D, type Canvas, type SKRSContext2D } from '@napi-rs/canvas'
import { classifyPageNeeds, drawingSignals, type PageNeed } from './pdfTriage'
import { chunkBlocks } from '../main/lib/chunker'
import { htmlBlocks } from './htmlBlocks'
import { pdfLayout, type PdfPageItems, type PdfTextItem } from './pdfLayout'
import { PdfBinaryDataFactory } from './pdfAssets'

// 资料解析（在工作进程中运行）。输出统一的分段，定位使用 W3C 选择器：
//   PDF  → page=N（可在内置 PDF 查看器中跳转到页）
//   EPUB → chapter=N
//   其他 → 文本字符偏移

export interface Segment {
  kind: string
  locator: Record<string, unknown>
  text: string
  heading?: string
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

async function loadPdfJs(): Promise<PdfJs> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // Electron 工作进程（process.type = 'utility'）不被 pdf.js 视为 Node，不会自动加载解析器：
  // 预先放到 globalThis.pdfjsWorker，pdf.js 会在当前进程内直接使用
  const g = globalThis as { pdfjsWorker?: unknown }
  g.pdfjsWorker ??= await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
  return pdfjs
}

export interface PdfParse {
  segments: Segment[]
  /** 需要识别的页（扫描页、表格页、图页），见 pdfTriage.ts */
  pages: { page: number; need: PageNeed }[]
}

export async function parsePdf(path: string, progress: (p: number) => void): Promise<PdfParse> {
  const pdfjs = await loadPdfJs()
  const data = new Uint8Array(await readFile(path))
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const task = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    wasmUrl: join(root, 'wasm') + '/',
    BinaryDataFactory: PdfBinaryDataFactory,
    useWorkerFetch: false
  })
  const doc = await task.promise
  const out: Segment[] = []
  const pages: PdfParse['pages'] = []
  const layout: PdfPageItems[] = []
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      let text = ''
      let lastY: number | null = null
      for (const item of content.items as { str: string; transform: number[]; hasEOL?: boolean }[]) {
        const y = item.transform?.[5]
        if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) text += '\n'
        text += item.str
        if (item.hasEOL) text += '\n'
        lastY = y ?? lastY
      }
      layout.push({
        page: p,
        bounds: { bottom: page.view[1], top: page.view[3] },
        items: content.items.filter((i) => 'str' in i) as PdfTextItem[]
      })
      try {
        const ops = await page.getOperatorList()
        const [x0, y0, x1, y1] = page.view
        const signals = {
          chars: text.replace(/\s/g, '').length,
          lines: text.split('\n'),
          ...drawingSignals(ops.fnArray, ops.argsArray, (x1 - x0) * (y1 - y0))
        }
        const needs = classifyPageNeeds(signals)
        for (const need of needs) pages.push({ page: p, need })
      } catch {
        // 分流失败不影响文字层
      }
      page.cleanup()
      progress(p / doc.numPages)
    }
    out.push(
      ...chunkBlocks(pdfLayout(layout), {
        locatorOf: (b) => ({ type: 'FragmentSelector', conformsTo: 'http://tools.ietf.org/rfc/rfc3778', value: `page=${b.page}` })
      }).map((c) => ({ ...c, kind: 'page' }))
    )
    return { segments: out, pages }
  } finally {
    await task.destroy()
  }
}

/** pdf.js 在工作进程中用 @napi-rs/canvas 绘制（随 pdfjs-dist 安装） */
class CanvasFactory {
  create(width: number, height: number): { canvas: Canvas; context: SKRSContext2D } {
    const canvas = createCanvas(width, height)
    return { canvas, context: canvas.getContext('2d') }
  }
  reset(cc: { canvas: Canvas }, width: number, height: number): void {
    cc.canvas.width = width
    cc.canvas.height = height
  }
  destroy(cc: { canvas: Canvas }): void {
    cc.canvas.width = 0
    cc.canvas.height = 0
  }
}

/** 把 PDF 的一页绘制成 JPEG（长边约 maxSide 像素），供看图识别 */
export async function renderPdfPage(path: string, pageNo: number, maxSide = 1600): Promise<Uint8Array> {
  // pdf.js 只在它认定的 Node 环境里自动补齐这些画布类型；工作进程中手动补齐
  const g = globalThis as Record<string, unknown>
  g.Path2D ??= Path2D
  g.DOMMatrix ??= DOMMatrix
  g.ImageData ??= ImageData
  const pdfjs = await loadPdfJs()
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const task = pdfjs.getDocument({
    data: new Uint8Array(await readFile(path)),
    // 工作进程没有 FontFace：字形按路径绘制
    disableFontFace: true,
    CanvasFactory,
    cMapUrl: join(root, 'cmaps') + '/',
    cMapPacked: true,
    standardFontDataUrl: join(root, 'standard_fonts') + '/',
    // JBIG2 解码在 utilityProcess 中不会自动找到 wasm，缺失时页面会悄悄丢失文字。
    wasmUrl: join(root, 'wasm') + '/',
    BinaryDataFactory: PdfBinaryDataFactory,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    verbosity: 0
  } as Parameters<PdfJs['getDocument']>[0])
  const doc = await task.promise
  try {
    const page = await doc.getPage(pageNo)
    const base = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: Math.min(4, maxSide / Math.max(base.width, base.height)) })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    type RenderParams = Parameters<typeof page.render>[0]
    await page.render({ canvas, canvasContext: ctx, viewport } as unknown as RenderParams).promise
    return new Uint8Array(await canvas.encode('jpeg', 88))
  } finally {
    await task.destroy()
  }
}

export async function parseHtml(path: string): Promise<{ title: string; segments: Segment[] }> {
  const html = await readFile(path, 'utf8')
  const { parseHTML } = await import('linkedom')
  const { Readability } = await import('@mozilla/readability')
  const { document } = parseHTML(html)
  const article = new Readability(document as never).parse()
  const blocks = htmlBlocks(article?.content ?? html)
  return {
    title: article?.title ?? document.title ?? '',
    segments: chunkBlocks(blocks, { locatorOf: (b) => ({ type: 'FragmentSelector', value: `block=${blocks.indexOf(b)}` }) })
  }
}

export async function parseEpub(path: string, progress: (p: number) => void): Promise<Segment[]> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(await readFile(path))
  const container = await zip.file('META-INF/container.xml')?.async('string')
  const opfPath = container?.match(/full-path="([^"]+)"/)?.[1]
  if (!opfPath) throw new Error('无效的 EPUB 文件')
  const opf = (await zip.file(opfPath)?.async('string')) ?? ''
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const manifest = new Map<string, string>()
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = m[0].match(/\bid="([^"]+)"/)?.[1]
    const href = m[0].match(/\bhref="([^"]+)"/)?.[1]
    if (id && href) manifest.set(id, decodeURIComponent(href))
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => m[1])
  const out: Segment[] = []
  for (let i = 0; i < spine.length; i++) {
    const href = manifest.get(spine[i])
    const html = href ? await zip.file(base + href)?.async('string') : null
    if (!html) continue
    const blocks = htmlBlocks(html)
    out.push(...chunkBlocks(blocks, { locatorOf: () => ({ type: 'FragmentSelector', value: `chapter=${i + 1}` }) }))
    progress((i + 1) / spine.length)
  }
  return out
}
