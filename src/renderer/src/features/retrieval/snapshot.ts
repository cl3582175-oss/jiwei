export interface SnapshotParagraph {
  text: string
  /** 原始快照正文的 UTF-16 半开区间，不含段落间的空行。 */
  start: number
  end: number
  highlighted: boolean
}

export function snapshotParagraphs(text: string, locator: string | null): SnapshotParagraph[] {
  const match = locator?.match(/^chars=(\d+)-(\d+)$/)
  const start = match ? Number(match[1]) : -1,
    end = match ? Number(match[2]) : -1
  const valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= text.length
  const paragraphs: SnapshotParagraph[] = []
  const append = (from: number, to: number): void => {
    const paragraph = text.slice(from, to)
    if (!paragraph.trim()) return
    paragraphs.push({ text: paragraph, start: from, end: to, highlighted: valid && from < end && to > start })
  }
  let from = 0
  // 不 trim / 重写正文；跳过空行时仍按原始字符串推进，保留后续引用的位置。
  for (const separator of text.matchAll(/\r?\n(?:[ \t]*\r?\n)+/g)) {
    append(from, separator.index)
    from = separator.index + separator[0].length
  }
  append(from, text.length)
  return paragraphs
}
