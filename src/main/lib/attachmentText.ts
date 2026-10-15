import type { Segment } from '@shared/types'
import { htmlTableToMarkdown } from './recognized'
import { tableBlockFromHtml } from './tableBlocks'

type TableParts = { head: string[]; rows: string[]; html?: boolean }
const tableParts = (text: string): TableParts | null => {
  const at = text.search(/<table\b/i)
  if (at >= 0) {
    const prefix = text.slice(0, at).trim(),
      parsed = tableBlockFromHtml(text.slice(at))
    if (parsed.html) {
      const rows = parsed.html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []
      return { head: [prefix, '<table>' + (rows[0] ?? '')].filter(Boolean), rows: rows.slice(1), html: true }
    }
    text = [prefix, htmlTableToMarkdown(text.slice(at))].filter(Boolean).join('\n')
  }
  const lines = text.split('\n')
  const separator = lines.findIndex((line) => /^\s*\|?\s*:?-{3,}/.test(line))
  return separator < 0
    ? null
    : { head: lines.slice(0, separator + 1), rows: lines.slice(separator + 1).filter((line) => line.startsWith('|')) }
}
const render = (parts: TableParts | null, rows: string[], notice: string): string =>
  [...(parts?.head ?? []), ...rows, ...(parts?.html ? ['</table>'] : []), notice].join('\n')

/** 存储保留全部行，给模型的表格预览每表仅前200行，并说明总行数。结构表按原块位置累计。 */
export function tablePreview(segments: Segment[]): Segment[] {
  const counts = new Map<string, number>()
  const tableKey = (s: Segment): string => s.sourceId + ':' + String(s.locator.value)
  const totals = new Map<string, number>()
  for (const s of segments)
    if (s.kind === 'table' && typeof s.locator.dataStart !== 'number' && typeof s.locator.value === 'string') {
      totals.set(tableKey(s), (totals.get(tableKey(s)) ?? 0) + (tableParts(s.text)?.rows.length ?? 0))
    }
  return segments.flatMap((s) => {
    if (s.kind !== 'table') return [s]
    const parts = tableParts(s.text)
    let start = typeof s.locator.dataStart === 'number' ? s.locator.dataStart : undefined
    let total = typeof s.locator.totalRows === 'number' ? s.locator.totalRows : undefined
    if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) {
      if (parts && typeof s.locator.value === 'string' && !('sheet' in s.locator)) {
        // 新 Word/PDF 表格跨多个段，稀疏命中仍需从原表开头计算行数。
        const key = tableKey(s)
        start = counts.get(key) ?? 0
        counts.set(key, start + parts.rows.length)
        total = totals.get(key) ?? parts.rows.length
        if (total <= 200) return [s]
      } else {
        return [
          {
            ...s,
            text: render(parts, [], `（共 ${total ?? '?'} 行数据；行序数未知，${parts ? '仅提供表头' : '未提供表格数据'}）`)
          }
        ]
      }
    }
    if (start >= 200) return []
    const rows = parts?.rows ?? []
    return [{ ...s, text: render(parts, rows.slice(0, 200 - start), `（共 ${total ?? rows.length} 行数据；仅提供前 200 行）`) }]
  })
}
