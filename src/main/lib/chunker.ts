import type { DocBlock } from './docBlocks'
import { normalizeExtracted } from './textNormalize'
import { expandedTableBlockFromHtml } from './tableBlocks'

export interface ChunkOut {
  kind: 'paragraph' | 'table' | 'code' | 'page'
  text: string
  heading: string
  locator: Record<string, unknown>
}
export const EMBED_MAX_CHARS = { zh: 1800, en: 6000 } as const
type Options = { lang?: 'zh' | 'en'; locatorOf: (b: DocBlock) => Record<string, unknown> }
type Piece = { text: string; block: DocBlock; join: string }

const chinese = (s: string): boolean => (s.match(/\p{Script=Han}/gu)?.length ?? 0) / Math.max(1, [...s].length) >= 0.3
const prefix = (s: string, length: number): string => {
  const end = Math.min(length, s.length)
  return s.slice(0, end > 0 && /[\uD800-\uDBFF]/.test(s[end - 1]) ? end - 1 : end)
}
/** 索引保留全文身份，只限制模型输入；不能让长标题或代码越过向量输入上限。 */
export const embeddingText = (text: string): string => prefix(text, EMBED_MAX_CHARS[chinese(text) ? 'zh' : 'en'])
const mdCell = (s: string): string => normalizeExtracted(s).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
const mdLine = (cells: string[], width: number): string =>
  `| ${Array.from({ length: width }, (_, i) => mdCell(cells[i] ?? '')).join(' | ')} |`

function splitParagraph(text: string, maximum: number): string[] {
  const parts: string[] = []
  let rest = text
  while (rest.length > maximum) {
    const window = prefix(rest, maximum)
    const ends = [...window.matchAll(/[。！？；.!?;]/g)]
    const end = ends.length ? ends.at(-1)!.index! + 1 : window.length
    parts.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  if (rest) parts.push(rest)
  return parts
}

export function chunkBlocks(blocks: DocBlock[], opts: Options): ChunkOut[] {
  const out: ChunkOut[] = []
  const stack: { level: number; text: string }[] = []
  // headingLevel 没有文档上下文；这里统一处理全篇的编/章/节关系。
  const hasParts = blocks.some((b) => b.type === 'heading' && /^第[〇零一二两三四五六七八九十百千\d]+(?:编|部分)/.test(b.text.trim()))
  let paragraphs: { text: string; block: DocBlock }[] = []
  const path = (): string =>
    prefix(
      stack
        .slice(0, 4)
        .map((h) => h.text)
        .join(' › '),
      120
    )
  const lang = (text: string): 'zh' | 'en' => opts.lang ?? (chinese(text) ? 'zh' : 'en')
  const emit = (kind: ChunkOut['kind'], text: string, first: DocBlock, pages: number[] = []): void => {
    if (!text.trim()) return
    const locator = { ...opts.locatorOf(first) }
    if (first.page !== undefined && pages.length && Math.max(...pages) > first.page) locator.pageEnd = Math.max(...pages)
    out.push({ kind, text, heading: path(), locator })
  }
  const flush = (): void => {
    if (!paragraphs.length) return
    const language = lang(paragraphs.map((p) => p.text).join(''))
    const [minimum, maximum, short] = language === 'zh' ? [300, 700, 80] : [1200, 2800, 300]
    const cap = EMBED_MAX_CHARS[language]
    const groups: Piece[][] = []
    let current: Piece[] = []
    let size = 0
    const finish = (): void => {
      if (current.length) groups.push(current)
      current = []
      size = 0
    }
    for (const p of paragraphs) {
      const parts = splitParagraph(p.text, maximum)
      for (let i = 0; i < parts.length; i++) {
        const piece = { text: parts[i], block: p.block, join: i === 0 ? '\n\n' : '' }
        if (
          current.length &&
          (size + piece.join.length + piece.text.length > cap || (size >= minimum && size + piece.text.length > maximum))
        )
          finish()
        size += (current.length ? piece.join.length : 0) + piece.text.length
        current.push(piece)
        if (size >= minimum) finish()
      }
    }
    finish()
    const body = (parts: Piece[]): string => parts.map((p, i) => (i ? p.join : '') + p.text).join('')
    for (let i = 0; i < groups.length; i++) {
      if (body(groups[i]).length >= short || groups.length === 1) continue
      if (i > 0 && body([...groups[i - 1], ...groups[i]]).length <= cap) {
        groups[i - 1].push(...groups[i])
        groups.splice(i--, 1)
      } else if (i + 1 < groups.length && body([...groups[i], ...groups[i + 1]]).length <= cap) {
        groups[i].push(...groups[i + 1])
        groups.splice(i + 1, 1)
      }
    }
    for (const g of groups)
      emit(
        'paragraph',
        body(g),
        g[0].block,
        g.flatMap((p) => (p.block.page === undefined ? [] : [p.block.page]))
      )
    paragraphs = []
  }
  const code = (block: Extract<DocBlock, { type: 'code' }>): void => {
    const text = normalizeExtracted(block.text),
      cap = EMBED_MAX_CHARS[lang(text)]
    let pending = ''
    for (const line of text.split('\n')) {
      if (pending && pending.length + line.length + 1 > cap) {
        emit('code', pending, block)
        pending = ''
      }
      if (line.length > cap) {
        let rest = line
        while (rest) {
          const part = prefix(rest, cap)
          emit('code', part, block)
          rest = rest.slice(part.length)
        }
      } else pending += (pending ? '\n' : '') + line
    }
    if (pending) emit('code', pending, block)
  }
  const table = (block: Extract<DocBlock, { type: 'table' }>): void => {
    const caption = block.caption ? normalizeExtracted(block.caption) + '\n' : ''
    const plainFallback = (text: string, cap: number): void => {
      // 表头自身已超过上限时，重复完整表头与硬上限无法兼得；完整保留内容，绝不截丢。
      for (const part of splitParagraph(text, cap)) emit('table', part, block)
    }
    if (block.html) {
      const html = normalizeExtracted(block.html)
      const cap = EMBED_MAX_CHARS[lang(html.replace(/<[^>]+>/g, ''))]
      if (caption.length + html.length <= cap) {
        emit('table', caption + html, block)
        return
      }
      if (/\browspan\s*=/i.test(html)) {
        const expanded = expandedTableBlockFromHtml(html)
        // 异常表格的列数与表头不一致时保留原布局，避免替作者猜测所属列。
        if (expanded.rows.every((r) => r.length <= (expanded.header?.length ?? 0))) {
          table({ ...expanded, caption: block.caption, page: block.page })
          return
        }
      }
      const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []
      const thead = html.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)
      const header = thead?.[1] ?? rows[0] ?? ''
      // 按结构移除表头；数据行即使与表头文字完全相同也不能丢掉。
      const data = thead ? (html.replace(thead[0], '').match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []) : rows.slice(1)
      let pending = ''
      const render = (body: string): string => `${caption}<table>${header}${body}</table>`
      if (render('').length >= cap - 80) {
        plainFallback(
          caption +
            html
              .replace(/<\/(?:td|th)>/gi, '；')
              .replace(/<\/(?:tr|p)>/gi, '\n')
              .replace(/<[^>]+>/g, ''),
          cap
        )
        return
      }
      for (const row of data) {
        if (pending && render(pending + row).length > cap) {
          emit('table', render(pending), block)
          pending = ''
        }
        if (render(row).length > cap) {
          // 异常长的单行不能截丢。转成文字后分段，保留表头与该行全部内容。
          const body = row.replace(/<\/(?:td|th)>/gi, '；').replace(/<[^>]+>/g, '')
          const head = header.replace(/<\/(?:td|th)>/gi, '；').replace(/<[^>]+>/g, '')
          const budget = Math.max(1, cap - caption.length - head.length - 1)
          for (const part of splitParagraph(body, budget)) emit('table', caption + head + '\n' + part, block)
        } else pending += row
      }
      if (pending) emit('table', render(pending), block)
      return
    }
    const width = Math.max(block.header?.length ?? 0, ...block.rows.map((r) => r.length), 1)
    const header = block.header ?? Array(width).fill('')
    const head = `${caption}${mdLine(header, width)}\n| ${Array(width).fill('---').join(' | ')} |`
    const cap = EMBED_MAX_CHARS[lang(head + block.rows.flat().join(''))]
    if (head.length >= cap - Math.max(80, width * 6)) {
      plainFallback(caption + [header.join('\t'), ...block.rows.map((r) => r.join('\t'))].map(normalizeExtracted).join('\n'), cap)
      return
    }
    let pending: string[] = []
    const render = (rows: string[]): string => [head, ...rows].join('\n')
    for (const cells of block.rows) {
      const row = mdLine(cells, width)
      if (pending.length && (render([...pending, row]).length > cap || (pending.length >= 3 && render([...pending, row]).length > 700))) {
        emit('table', render(pending), block)
        pending = []
      }
      if (render([row]).length > cap) {
        const values = Array.from({ length: width }, (_, i) => mdCell(cells[i] ?? ''))
        const allowance = cap - head.length - 1
        const repeated = values.map((v) => (v.length <= allowance / (width * 2) ? v : ''))
        const remaining = values.map((v, i) => (repeated[i] ? '' : v))
        const lineOf = (cells: string[]): string => `| ${cells.join(' | ')} |`
        const longCount = remaining.filter(Boolean).length
        const budget = Math.floor((allowance - lineOf(repeated).length) / Math.max(1, longCount))
        if (budget < 2) {
          plainFallback([head, row].join('\n'), cap)
          continue
        }
        while (remaining.some(Boolean)) {
          const next = repeated.map((v, i) => {
            if (v || !remaining[i]) return v
            let part = prefix(remaining[i], budget)
            if (part.endsWith('\\') && remaining[i][part.length] === '|') part = part.slice(0, -1)
            remaining[i] = remaining[i].slice(part.length)
            return part
          })
          emit('table', head + '\n' + lineOf(next), block)
        }
      } else pending.push(row)
    }
    if (pending.length || !block.rows.length) emit('table', render(pending), block)
  }

  for (const b of blocks) {
    if (b.type === 'heading') {
      flush()
      const text = normalizeExtracted(b.text).trim()
      let level = b.level
      if (hasParts && /^第[〇零一二两三四五六七八九十百千\d]+章/.test(text)) level = 2
      else if (hasParts && /^第[〇零一二两三四五六七八九十百千\d]+节/.test(text)) level = 3
      while (stack.length && stack.at(-1)!.level >= level) stack.pop()
      stack.push({ level, text })
    } else if (b.type === 'paragraph') {
      const text = normalizeExtracted(b.text).trim()
      if (text) paragraphs.push({ text, block: b })
    } else if (b.type === 'table') {
      const size = (b.header?.join('') ?? '') + b.rows.flat().join('')
      if (!b.html && b.rows.length <= 2 && size.length < 80) {
        const text = b.rows.length
          ? b.rows.map((r) => r.map((value, i) => `${b.header?.[i] ?? ''}：${value}`).join('；')).join('\n')
          : (b.header?.join('；') ?? '')
        paragraphs.push({ text: normalizeExtracted((b.caption ? b.caption + '\n' : '') + text), block: b })
      } else {
        flush()
        table(b)
      }
    } else {
      flush()
      code(b)
    }
  }
  flush()
  return out
}
