import { headingLevel, type DocBlock } from '../main/lib/docBlocks'
import { normalizeExtracted } from '../main/lib/textNormalize'

export interface PdfTextItem {
  str: string
  transform: number[]
  height: number
  width: number
  hasEOL?: boolean
}
export interface PdfPageItems {
  page: number
  items: PdfTextItem[]
  bounds?: { bottom: number; top: number }
}
export interface PdfLine {
  text: string
  x: number
  y: number
  height: number
}
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const hanEnd = /[\p{Script=Han}，。！？；：、）》」』】]$/u
const hanStart = /^[\p{Script=Han}，。！？；：、（《「『【]/u
function joinLines(a: string, b: string): string {
  if (a.endsWith('-') && /^[a-z]/.test(b)) return a.slice(0, -1) + b
  return a + (hanEnd.test(a) && hanStart.test(b) ? '' : ' ') + b
}

export function linesFromItems(items: PdfTextItem[]): PdfLine[] {
  const rows: { y: number; height: number; items: PdfTextItem[] }[] = []
  for (const item of [...items].filter((i) => i.str.trim()).sort((a, b) => b.transform[5] - a.transform[5])) {
    const height = Math.abs(item.height || item.transform[3]) || 10
    const y = item.transform[5]
    const row = rows.find((r) => Math.abs(r.y - y) <= Math.min(r.height, height) * 0.5)
    if (row) row.items.push(item)
    else rows.push({ y, height, items: [item] })
  }
  return rows.map((row) => {
    const ordered = row.items.sort((a, b) => a.transform[4] - b.transform[4])
    let text = ''
    for (let i = 0; i < ordered.length; i++) {
      const current = normalizeExtracted(ordered[i].str)
      const previous = ordered[i - 1]
      const gap = previous ? ordered[i].transform[4] - previous.transform[4] - previous.width : 0
      if (text && !/\s$/.test(text) && !/^\s/.test(current) && gap > row.height * 0.25 && !(hanEnd.test(text) && hanStart.test(current)))
        text += ' '
      text += current
    }
    return {
      text: text.trim(),
      x: ordered[0].transform[4],
      y: row.y,
      height: median(ordered.map((i) => Math.abs(i.height || i.transform[3]) || 10))
    }
  })
}

const furnitureKey = (s: string): string => s.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
const pageNumber = (s: string): boolean => /^(?:#|-\s*#\s*-|第\s*#\s*页|#\s*\/\s*#)$/.test(furnitureKey(s))
const toc = (s: string): boolean => /(?:[.．·─]\s*){4,}\s*\d+\s*$|…+\s*\d+\s*$/.test(s)

/** 全篇分析边缘重复行，随后按页恢复段落；这里只处理文字层，不推断表格语义。 */
export function pdfLayout(pages: PdfPageItems[]): DocBlock[] {
  const all = pages.map((p) => ({ ...p, lines: linesFromItems(p.items) }))
  const edge = (p: (typeof all)[number], l: PdfLine, i: number): boolean => {
    if (!p.bounds) return false
    const margin = Math.min(50, (p.bounds.top - p.bounds.bottom) * 0.08)
    return (i < 2 && l.y + l.height >= p.bounds.top - margin) || (i >= p.lines.length - 2 && l.y <= p.bounds.bottom + margin)
  }
  const count = new Map<string, number>()
  for (const p of all) {
    for (const key of new Set(p.lines.filter((l, i) => edge(p, l, i)).map((l) => furnitureKey(l.text))))
      count.set(key, (count.get(key) ?? 0) + 1)
  }
  const repeated = new Set([...count].filter(([, n]) => all.length >= 4 && n >= all.length * 0.3).map(([key]) => key))
  const bodyFont = median(all.flatMap((p) => p.lines.map((l) => l.height))) || 10
  const isFontHeading = (l: PdfLine): boolean =>
    l.height >= bodyFont * 1.15 && l.text.length <= (/\p{Script=Han}/u.test(l.text) ? 40 : 90) && !/[:：]\s*\S|[。；;.!?]$/.test(l.text)
  const fonts = [...new Set(all.flatMap((p) => p.lines.filter(isFontHeading).map((l) => l.height)))].sort((a, b) => b - a)
  const out: DocBlock[] = []
  for (const p of all) {
    const lines = p.lines.filter(
      // 稀疏页的首尾行仍可能是正文；只有物理页边缘有证据时才删除重复行。
      (l, i) => !(edge(p, l, i) && (pageNumber(l.text) || repeated.has(furnitureKey(l.text))))
    )
    if (lines.filter((l) => toc(l.text)).length >= 5) {
      out.push({ type: 'paragraph', text: lines.map((l) => l.text).join('\n'), page: p.page })
      continue
    }
    const spacing =
      median(
        lines
          .slice(1)
          .map((l, i) => lines[i].y - l.y)
          .filter((d) => d > 0)
      ) || bodyFont * 1.4
    const lineLength = median(lines.map((l) => l.text.length))
    let pending = ''
    const flush = (): void => {
      if (pending) out.push({ type: 'paragraph', text: pending, page: p.page })
      pending = ''
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i],
        prev = lines[i - 1]
      const level = headingLevel(line.text) ?? (isFontHeading(line) ? Math.min(3, fonts.indexOf(line.height) + 1) : null)
      if (level && !toc(line.text)) {
        flush()
        out.push({ type: 'heading', level, text: line.text, page: p.page })
        continue
      }
      if (
        pending &&
        prev &&
        (prev.y - line.y > spacing * 1.6 ||
          line.x - prev.x > bodyFont * 1.5 ||
          (/[。！？；.!?;]$/.test(prev.text) && prev.text.length < lineLength * 0.7))
      )
        flush()
      pending = pending ? joinLines(pending, line.text) : line.text
    }
    flush()
  }
  return out
}
