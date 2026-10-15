// 文档识别结果的整理（纯函数，便于测试）：
// - 识别模型输出的 HTML 表格 → Markdown 表格（有合并单元格时保留精简的 HTML，模型都读得懂）
// - 表格页只保留表格和表标题（正文已在文字层中）
// - 长表格按行切分，每段重复表头，检索命中任何一段都能看懂各列含义
// - 并入资料分段：插在同一页的文字之后
import { normalizeExtracted } from './textNormalize'
import { structuredTextBlocks } from './structuredText'
import { chunkBlocks } from './chunker'
import type { DocBlock } from './docBlocks'
import { tableBlockFromHtml } from './tableBlocks'

export type RecognizedNeed = 'scan' | 'table' | 'figure'

export interface SegmentLike {
  kind: string
  locator: Record<string, unknown>
  text: string
  heading?: string
}

export const OCR_KIND_PREFIX = 'ocr:'
export const FIGURE_PREFIX = '［图解］'

const decode = (s: string): string =>
  s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

/** 一张 HTML 表格 → Markdown；有合并单元格时返回精简的 HTML */
export function htmlTableToMarkdown(html: string): string {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<t([hd])([^>]*)>([\s\S]*?)<\/t[hd]>/gi)].map((c) => ({
      th: c[1].toLowerCase() === 'h',
      attrs: c[2],
      text: decode(c[3])
    }))
  )
  if (!rows.length) return decode(html)
  if (rows.some((r) => r.some((c) => [...c.attrs.matchAll(/(?:row|col)span\s*=\s*["']?\s*(\d+)/gi)].some((m) => Number(m[1]) >= 2)))) {
    // 保留结构，去掉样式属性和多余空白
    return tableBlockFromHtml(html).html ?? ''
  }
  // 表头：首行全部为空的“标题行”（如“项目特性”横跨整行）跳过，取下一行
  let body = rows.filter((r) => r.some((c) => c.text))
  if (!body.length) return ''
  if (body.length && body[0].filter((c) => c.text).length === 1 && body[0].length > 1 && body.length > 1) body = body.slice(1)
  const width = Math.max(...body.map((r) => r.length))
  const cell = (s: string): string => s.replace(/\|/g, '\\|')
  const line = (r: { text: string }[]): string => `| ${Array.from({ length: width }, (_, i) => cell(r[i]?.text ?? '')).join(' | ')} |`
  return [line(body[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...body.slice(1).map(line)].join('\n')
}

/** 把文本中的 HTML 表格就地换成 Markdown，并去掉代码围栏 */
export function normalizeRecognized(text: string): string {
  return text
    .replace(/^```(?:markdown|md|html)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .replace(/<table[\s\S]*?<\/table>/gi, (t) => htmlTableToMarkdown(t))
    .replace(/!\[[^\]]*\]\([^)]*\)\s*/g, '') // 模型输出的图片占位
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const TABLE_CAPTION = /^\s*(?:表\s*\d+(?:[-–.．]\d+)*|Table\s+\d+(?:[-–.]\d+)*)\s*[。.．:：\s]/

/** 表格页：只保留表标题与表格（Markdown 或 HTML），正文已在文字层中 */
export function extractTables(text: string): string {
  const out: string[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    // 标题行可能带 Markdown 标记（# 标题、**加粗**）
    const plain = l
      .replace(/^[#>\s]+/, '')
      .replace(/[*_]{1,2}/g, '')
      .trim()
    if (TABLE_CAPTION.test(plain) && plain.length <= 90) out.push(plain)
    else if (/^\s*\|/.test(l)) {
      const block: string[] = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) block.push(lines[i++].trim())
      i--
      out.push(block.join('\n'))
    } else if (/<table/i.test(l)) {
      const block: string[] = []
      while (i < lines.length) {
        block.push(lines[i])
        if (/<\/table>/i.test(lines[i])) break
        i++
      }
      out.push(block.join('\n'))
    }
  }
  return out.join('\n\n').trim()
}

/** 文字层中的表标题行（识别结果漏掉标题时补上） */
export function tableCaptions(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => TABLE_CAPTION.test(l) && l.length <= 90)
}

/** 识别出的表格缺少标题时，用文字层的标题补在最前面 */
export function withCaptions(tables: string, pageText: string): string {
  if (!tables || tables.split('\n').some((l) => TABLE_CAPTION.test(l))) return tables
  const caps = tableCaptions(pageText)
  return caps.length ? `${caps.join('\n')}\n\n${tables}` : tables
}

/** 识别结果是否退化（同一字符或短语大量重复，llama.cpp 视觉模型偶发） */
export function isDegenerate(text: string): boolean {
  if (/(.)\1{40,}/u.test(text)) return true
  const m = text.match(/(.{2,12}?)\1{15,}/u)
  return !!m
}

const pageOf = (s: SegmentLike): number | null => {
  const m = String((s.locator as { value?: unknown }).value ?? '').match(/^page=(\d+)/)
  return m ? Number(m[1]) : null
}

export const pageLocator = (page: number): Record<string, unknown> => ({
  type: 'FragmentSelector',
  conformsTo: 'http://tools.ietf.org/rfc/rfc3778',
  value: `page=${page}`
})

export type HeadingBlock = Extract<DocBlock, { type: 'heading' }>
/** 按页传递标题栈，识别段插在同页文字后；扫描页按页码并入。 */
export function mergeRecognized(
  segments: SegmentLike[],
  recs: { page: number; need: RecognizedNeed; text: string }[],
  initialHeadings: HeadingBlock[] = []
): SegmentLike[] {
  const out = segments.filter((s) => !s.kind.startsWith(OCR_KIND_PREFIX))
  const stack = [...initialHeadings]
  const part = /^第[〇零一二两三四五六七八九十百千\d]+(?:编|部分)/
  const hasParts =
    stack.some((b) => part.test(b.text.trim())) ||
    recs.some(
      (r) =>
        r.need === 'scan' && structuredTextBlocks(normalizeExtracted(r.text)).some((b) => b.type === 'heading' && part.test(b.text.trim()))
    )
  for (const r of [...recs].sort((a, b) => a.page - b.page)) {
    const text = normalizeExtracted(r.text)
    const kind = `${OCR_KIND_PREFIX}${r.need}`,
      locator = pageLocator(r.page)
    const add: SegmentLike[] = []
    // 章节的有效层级也必须保存在延续栈中，否则下一页会把“编”父节点弹掉。
    const blocks = structuredTextBlocks(text).map((b) => {
      if (b.type !== 'heading' || !hasParts) return b
      if (/^第[〇零一二两三四五六七八九十百千\d]+章/.test(b.text.trim())) return { ...b, level: 2 }
      if (/^第[〇零一二两三四五六七八九十百千\d]+节/.test(b.text.trim())) return { ...b, level: 3 }
      return b
    })
    let pending: DocBlock[] = []
    const path = (): string =>
      stack
        .slice(0, 4)
        .map((h) => h.text)
        .join(' › ')
        .slice(0, 120)
    const flush = (): void => {
      if (pending.length) add.push(...chunkBlocks([...stack, ...pending], { locatorOf: () => locator }).map((c) => ({ ...c, kind })))
      for (const b of pending)
        if (b.type === 'heading') {
          while (stack.length && stack.at(-1)!.level >= b.level) stack.pop()
          stack.push(b)
        }
      pending = []
    }
    if (r.need === 'figure') {
      if (text.trim()) add.push({ kind, locator, heading: path(), text: text.startsWith(FIGURE_PREFIX) ? text : FIGURE_PREFIX + text })
    } else {
      for (const b of blocks) {
        if (b.type === 'paragraph' && b.text.startsWith(FIGURE_PREFIX)) {
          flush()
          add.push({ kind, locator, heading: path(), text: b.text })
        } else pending.push({ ...b, page: r.page })
      }
      flush()
    }
    let at = -1
    for (let i = 0; i < out.length; i++) {
      const page = pageOf(out[i])
      if (page !== null && page <= r.page) at = i
      if (page !== null && page > r.page) break
    }
    out.splice(at + 1, 0, ...add)
  }
  return out
}

/* ——— LightOnOCR-3 的 grounding 输出 ——— */

/** 一个版面块：类型、坐标（页面归一化到 0–1000：左、上、右、下）、内容 */
export interface GroundBlock {
  label: string
  box: [number, number, number, number]
  text: string
}

const BLOCK_HEAD = /^!\[([a-z_]+)(\+?)\]\((\d+),(\d+),(\d+),(\d+)\)[ \t]*(.*)$/

/** 解析 grounding 输出：每块以 ![类型](x0,y0,x1,y1) 开头，内容在同一行或随后几行；“+”表示接续上一块 */
export function parseGrounding(text: string): GroundBlock[] {
  const out: GroundBlock[] = []
  let cur: (GroundBlock & { lines: string[] }) | null = null
  const flush = (): void => {
    if (!cur) return
    const t = cur.lines.join('\n').trim()
    out.push({ label: cur.label, box: cur.box, text: t })
    cur = null
  }
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const m = BLOCK_HEAD.exec(line.trim())
    if (m) {
      flush()
      const box = [m[3], m[4], m[5], m[6]].map(Number) as GroundBlock['box']
      // 接续块：并入上一个同类块
      const prev = out[out.length - 1]
      if (m[2] === '+' && prev && prev.label === m[1]) {
        out.pop()
        cur = { label: prev.label, box: prev.box, text: '', lines: [prev.text, m[7]] }
      } else cur = { label: m[1], box, text: '', lines: m[7] ? [m[7]] : [] }
    } else if (cur) cur.lines.push(line)
  }
  flush()
  return out
}

const PAGE_FURNITURE = new Set(['header', 'footer', 'page_number', 'header_image', 'footer_image'])
const FIGURE_CAPTION_TEXT = /^\s*(?:图\s*\d|Fig(?:ure|\.)\s*\d)/
const TABLE_CAPTION_TEXT = /^\s*(?:表\s*\d|Table\s+\d)/

/** 图 / 表块的标题：紧邻的 caption 块（前后各看一块） */
function captionFor(blocks: GroundBlock[], i: number, re: RegExp): string | null {
  for (const j of [i + 1, i - 1]) {
    const b = blocks[j]
    if (b?.label === 'caption' && re.test(b.text)) return b.text.trim()
  }
  return null
}

/**
 * 按页面类型整理 grounding 结果：
 * - scan：整页内容（去掉页眉、页脚、页码），插图为“［图解］描述”，图表为数据表
 * - table：只取表格及其标题
 * - figure：只取插图描述与图表数据（带图号标题）
 */
export function groundedText(blocks: GroundBlock[], need: RecognizedNeed): string {
  const parts: string[] = []
  blocks.forEach((b, i) => {
    if (!b.text || PAGE_FURNITURE.has(b.label)) return
    if (b.label === 'image' || b.label === 'chart') {
      if (need === 'table') return
      const cap = captionFor(blocks, i, FIGURE_CAPTION_TEXT)
      const body = b.label === 'image' ? b.text : `${b.text}`
      parts.push(need === 'figure' ? `${cap ? `${cap}：` : ''}${body}` : `${FIGURE_PREFIX}${cap ? `${cap}：` : ''}${body}`)
      return
    }
    if (b.label === 'table') {
      if (need === 'figure') return
      const cap = captionFor(blocks, i, TABLE_CAPTION_TEXT)
      parts.push(need === 'table' && cap ? `${cap}\n\n${b.text}` : b.text)
      return
    }
    if (need !== 'scan') return
    // 图 / 表的标题已随图表输出
    if (
      b.label === 'caption' &&
      (blocks[i - 1]?.label === 'image' ||
        blocks[i - 1]?.label === 'chart' ||
        blocks[i + 1]?.label === 'table' ||
        blocks[i - 1]?.label === 'table')
    )
      return
    parts.push(b.label === 'title' && !b.text.startsWith('#') ? `## ${b.text}` : b.text)
  })
  return normalizeRecognized(parts.join('\n\n'))
}
