import type { Segment } from '@shared/types'
import { htmlTableToMarkdown } from './recognized'

const markdownParts = (text: string): { head: string[]; rows: string[] } | null => {
  const lines = (/<table\b/i.test(text) ? htmlTableToMarkdown(text) : text).split('\n')
  const separator = lines.findIndex((line) => /^\s*\|?\s*:?-{3,}/.test(line))
  return separator < 0
    ? null
    : { head: lines.slice(0, separator + 1), rows: lines.slice(separator + 1).filter((line) => line.startsWith('|')) }
}

/** 存储保留全部行，给模型的表格预览每表仅前200行，并说明总行数。结构表按原块位置累计。 */
export function tablePreview(segments: Segment[]): Segment[] {
  const counts = new Map<string, number>()
  const tableKey = (s: Segment): string => s.sourceId + ':' + String(s.locator.value)
  const totals = new Map<string, number>()
  for (const s of segments)
    if (s.kind === 'table' && typeof s.locator.dataStart !== 'number' && typeof s.locator.value === 'string') {
      totals.set(tableKey(s), (totals.get(tableKey(s)) ?? 0) + (markdownParts(s.text)?.rows.length ?? 0))
    }
  return segments.flatMap((s) => {
    if (s.kind !== 'table') return [s]
    const parts = markdownParts(s.text)
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
            text: [...(parts?.head ?? s.text.split('\n').slice(0, 3)), `（共 ${total ?? '?'} 行数据；行序数未知，仅提供表头）`].join('\n')
          }
        ]
      }
    }
    if (start >= 200) return []
    const head = parts?.head ?? s.text.split('\n').slice(0, 3),
      rows = parts?.rows ?? []
    return [{ ...s, text: [...head, ...rows.slice(0, 200 - start), `（共 ${total ?? rows.length} 行数据；仅提供前 200 行）`].join('\n') }]
  })
}
