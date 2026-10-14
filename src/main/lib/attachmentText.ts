import type { Segment } from '@shared/types'

/** 存储保留全部行，给模型的表格预览每表仅前200行，并说明总行数。 */
export function tablePreview(segments: Segment[]): Segment[] {
  return segments.flatMap((s) => {
    if (s.kind !== 'table') return [s]
    // 使用数据行序数，不能按本次拿到的片段重新从0计数（稀疏Excel物理行号也不能当序数）。
    const start = s.locator.dataStart
    if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) {
      return [
        {
          ...s,
          text: [...s.text.split('\n').slice(0, 3), `（共 ${s.locator.totalRows ?? '?'} 行数据；行序数未知，仅提供表头）`].join('\n')
        }
      ]
    }
    if (start >= 200) return []
    const lines = s.text.split('\n'),
      rows = lines.slice(3).filter((l) => l.startsWith('|'))
    const keep = rows.slice(0, 200 - start)
    return [
      { ...s, text: [...lines.slice(0, 3), ...keep, `（共 ${s.locator.totalRows ?? rows.length} 行数据；仅提供前 200 行）`].join('\n') }
    ]
  })
}
