import type { Segment } from '@shared/types'

/** 存储保留全部行，给模型的表格预览每表仅前200行，并说明总行数。 */
export function tablePreview(segments: Segment[]): Segment[] {
  const counts = new Map<string, number>()
  return segments.flatMap((s) => {
    if (s.kind !== 'table') return [s]
    const key = String(s.locator.sheet ?? ''),
      used = counts.get(key) ?? 0
    if (used >= 200) return []
    const lines = s.text.split('\n'),
      rows = lines.slice(3).filter((l) => l.startsWith('|'))
    const keep = rows.slice(0, 200 - used)
    counts.set(key, used + keep.length)
    return [
      { ...s, text: [...lines.slice(0, 3), ...keep, `（共 ${s.locator.totalRows ?? rows.length} 行数据；仅提供前 200 行）`].join('\n') }
    ]
  })
}
