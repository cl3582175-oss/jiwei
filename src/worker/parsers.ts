import { readFile } from 'fs/promises'
import { segmentText, type TextSegment } from '../main/lib/segment'

// 资料解析（在工作进程中运行）。输出统一的分段，定位使用 W3C 选择器：
//   PDF  → page=N（可在内置 PDF 查看器中跳转到页）
//   EPUB → chapter=N
//   其他 → 文本字符偏移

export interface Segment {
  kind: string
  locator: Record<string, unknown>
  text: string
}

const MAX = 1800

/** linkedom 解析出的文档：只声明用到的部分（工作进程不包含 DOM 类型） */
interface DomDoc {
  title?: string
  body?: { textContent: string | null } | null
  querySelectorAll(selector: string): ArrayLike<{ textContent: string | null }>
}

/** 长文本按段落切分，保留同一定位 */
function splitWithLocator(text: string, locator: Record<string, unknown>, kind: string): Segment[] {
  const clean = text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!clean) return []
  if (clean.length <= MAX) return [{ kind, locator, text: clean }]
  return segmentText(clean, 'plain').map((s: TextSegment) => ({ kind, locator, text: s.text }))
}

export async function parsePdf(path: string, progress: (p: number) => void): Promise<Segment[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(await readFile(path))
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise
  const out: Segment[] = []
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
    out.push(
      ...splitWithLocator(text, { type: 'FragmentSelector', conformsTo: 'http://tools.ietf.org/rfc/rfc3778', value: `page=${p}` }, 'page')
    )
    progress(p / doc.numPages)
  }
  await doc.cleanup()
  return out
}

export async function parseDocx(path: string): Promise<Segment[]> {
  const mammoth = await import('mammoth')
  const { value } = await mammoth.extractRawText({ path })
  return segmentText(value, 'plain')
}

async function htmlToText(html: string): Promise<{ title: string; text: string }> {
  const { parseHTML } = await import('linkedom')
  const { Readability } = await import('@mozilla/readability')
  const { document } = parseHTML(html) as unknown as { document: DomDoc }
  const article = new Readability(document as never).parse()
  if (article?.textContent) return { title: article.title ?? '', text: article.textContent }
  return { title: document.title ?? '', text: document.body?.textContent ?? '' }
}

export async function parseHtml(path: string): Promise<{ title: string; segments: Segment[] }> {
  const { title, text } = await htmlToText(await readFile(path, 'utf8'))
  return { title, segments: segmentText(text.replace(/\n\s*\n/g, '\n\n'), 'plain') }
}

export async function parseEpub(path: string, progress: (p: number) => void): Promise<Segment[]> {
  const JSZip = (await import('jszip')).default
  const { parseHTML } = await import('linkedom')
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
    const { document } = parseHTML(html) as unknown as { document: DomDoc }
    const blocks = Array.from(document.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,pre'))
      .map((el) => el.textContent?.trim() ?? '')
      .filter(Boolean)
    const text = blocks.length ? blocks.join('\n\n') : (document.body?.textContent ?? '')
    out.push(...splitWithLocator(text, { type: 'FragmentSelector', value: `chapter=${i + 1}` }, 'chapter'))
    progress((i + 1) / spine.length)
  }
  return out
}
