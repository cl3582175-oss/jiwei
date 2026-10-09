// 文档识别结果的整理（纯函数，便于测试）：
// - 识别模型输出的 HTML 表格 → Markdown 表格（有合并单元格时保留精简的 HTML，模型都读得懂）
// - 表格页只保留表格和表标题（正文已在文字层中）
// - 长表格按行切分，每段重复表头，检索命中任何一段都能看懂各列含义
// - 并入资料分段：插在同一页的文字之后

export type RecognizedNeed = 'scan' | 'table' | 'figure'

export interface SegmentLike {
  kind: string
  locator: Record<string, unknown>
  text: string
}

export const OCR_KIND_PREFIX = 'ocr:'
export const FIGURE_PREFIX = '［图解］'
const MAX = 1800

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
    [...m[1].matchAll(/<t([hd])([^>]*)>([\s\S]*?)<\/t[hd]>/gi)].map((c) => ({ th: c[1].toLowerCase() === 'h', attrs: c[2], text: decode(c[3]) }))
  )
  if (!rows.length) return decode(html)
  if (rows.some((r) => r.some((c) => /(row|col)span\s*=\s*["']?\s*[2-9]/i.test(c.attrs)))) {
    // 保留结构，去掉样式属性和多余空白
    return html
      .replace(/\s(?:style|class|border|align|width|valign)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, '')
      .replace(/>\s+</g, '><')
      .replace(/<\/?(?:thead|tbody|tfoot)>/gi, '')
      .trim()
  }
  // 表头：首行全部为空的“标题行”（如“项目特性”横跨整行）跳过，取下一行
  let body = rows.filter((r) => r.some((c) => c.text))
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
    const plain = l.replace(/^[#>\s]+/, '').replace(/[*_]{1,2}/g, '').trim()
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

/** 长文本切分；Markdown 表格按行切，每段重复表头 */
export function splitRecognized(text: string, max = MAX): string[] {
  if (text.length <= max) return [text]
  const parts: string[] = []
  let cur = ''
  const push = (): void => {
    if (cur.trim()) parts.push(cur.trim())
    cur = ''
  }
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n')
    const isTable = lines.length > 2 && lines.every((l) => /^\s*\|/.test(l)) && /^\s*\|\s*-{3}/.test(lines[1])
    if (isTable && block.length > max) {
      push()
      const head = lines.slice(0, 2).join('\n')
      let chunk = head
      for (const row of lines.slice(2)) {
        if (chunk.length + row.length + 1 > max && chunk !== head) {
          parts.push(chunk)
          chunk = head
        }
        chunk += '\n' + row
      }
      if (chunk !== head) parts.push(chunk)
      continue
    }
    if (cur.length + block.length + 2 > max) push()
    if (block.length > max) {
      for (let i = 0; i < block.length; i += max) parts.push(block.slice(i, i + max))
      continue
    }
    cur += (cur ? '\n\n' : '') + block
  }
  push()
  return parts
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

/**
 * 把识别结果并入分段：去掉旧的识别分段，每页的识别分段插在该页文字之后；
 * 没有文字的页（扫描页）按页码顺序插入。
 */
export function mergeRecognized(segments: SegmentLike[], recs: { page: number; need: RecognizedNeed; text: string }[]): SegmentLike[] {
  const base = segments.filter((s) => !s.kind.startsWith(OCR_KIND_PREFIX))
  const out = [...base]
  for (const r of [...recs].sort((a, b) => a.page - b.page)) {
    const text = r.need === 'figure' && !r.text.startsWith(FIGURE_PREFIX) ? `${FIGURE_PREFIX}${r.text}` : r.text
    const add = splitRecognized(text).map((t) => ({ kind: `${OCR_KIND_PREFIX}${r.need}`, locator: pageLocator(r.page), text: t }))
    let at = -1
    for (let i = 0; i < out.length; i++) {
      const p = pageOf(out[i])
      if (p !== null && p <= r.page) at = i
      if (p !== null && p > r.page) break
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
    if (b.label === 'caption' && (blocks[i - 1]?.label === 'image' || blocks[i - 1]?.label === 'chart' || blocks[i + 1]?.label === 'table' || blocks[i - 1]?.label === 'table'))
      return
    parts.push(b.label === 'title' && !b.text.startsWith('#') ? `## ${b.text}` : b.text)
  })
  return normalizeRecognized(parts.join('\n\n'))
}
