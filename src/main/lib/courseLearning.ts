import { segmentTime, type CourseSegment } from '@shared/course'
import type { DocJSON, DocNode } from '@shared/types'
import { markdownToNodes } from './markdown'

// 课程材料的边界与原话保留规则独立于模型，便于检验长材料和异步重校验。
export const COURSE_CHUNK_SIZE = 6000
export interface CourseEvidenceChunk {
  text: string
  segments: CourseSegment[]
}
export interface CourseQuickNote {
  rowId: string | null
  text: string
  t: number
}
type BlockNode = DocNode & { type: string }

/** 每个片段都带完整的时间标记；一条超长字幕拆开时，后续块重复同一标记。 */
export function chunkCourseEvidence(segments: CourseSegment[], limit = COURSE_CHUNK_SIZE): CourseEvidenceChunk[] {
  if (!Number.isInteger(limit) || limit < 128) throw new Error('Course chunk limit is too small')
  const out: CourseEvidenceChunk[] = []
  let chunk: CourseEvidenceChunk = { text: '', segments: [] }
  const flush = (): void => {
    if (chunk.text) out.push(chunk)
    chunk = { text: '', segments: [] }
  }
  for (const segment of segments) {
    const time = segmentTime(segment)
    if (!time || !segment.text.trim() || (segment.kind !== 'transcript' && segment.kind !== 'slide')) continue
    const prefix = `[${segment.kind} t=${time[0]},${time[1]}] `
    const available = limit - prefix.length
    for (let from = 0; from < segment.text.length;) {
      let to = Math.min(segment.text.length, from + available)
      // 不能把中文材料中的表情等代理对切成两个无效字符。
      if (to < segment.text.length && /[\uD800-\uDBFF]/.test(segment.text[to - 1])) to--
      const part = prefix + segment.text.slice(from, to)
      if (chunk.text && chunk.text.length + part.length + 1 > limit) flush()
      chunk.text += `${chunk.text ? '\n' : ''}${part}`
      if (!chunk.segments.includes(segment)) chunk.segments.push(segment)
      from = to
    }
  }
  flush()
  return out
}

/** 自动采集可以追加材料；已经发给模型的文字、时间或图片归属改变后必须重来。 */
export function courseEvidencePresent(expected: CourseSegment[], current: CourseSegment[]): boolean {
  const key = (s: CourseSegment): string =>
    JSON.stringify({
      kind: s.kind,
      time: segmentTime(s),
      text: s.text,
      image: s.locator.image ?? null,
      speaker: s.locator.speaker ?? null,
      speakerPart: s.locator.speakerPart ?? null
    })
  const present = new Set(current.map(key))
  return expected.every((s) => present.has(key(s)))
}

/** 读取显示的原话，不经过 Markdown 往返转换；显式换行也属于原话。 */
export function courseNodeText(node: DocNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'hardBreak') return '\n'
  const inline = node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock'
  return (node.content ?? []).map(courseNodeText).join(inline ? '' : '\n')
}

export function courseQuickNotes(doc: DocJSON, sourceId: string): CourseQuickNote[] {
  const notes: CourseQuickNote[] = []
  for (const row of doc.content ?? []) {
    if (row.type !== 'cornellRow') continue
    let at: number | null = null
    const visit = (node: DocNode): void => {
      for (const mark of node.marks ?? []) {
        if (at !== null || mark.type !== 'link' || typeof mark.attrs?.href !== 'string') continue
        try {
          const url = new URL(mark.attrs.href)
          const value = url.searchParams.get('t')
          if (
            url.protocol === 'jiwei:' &&
            url.hostname === 'source' &&
            url.pathname === `/${sourceId}` &&
            value &&
            /^\d+(?:\.\d+)?$/.test(value) &&
            Number.isFinite(Number(value))
          )
            at = Number(value)
        } catch {
          /* 畸形外部链接不影响其他课程速记。 */
        }
      }
      node.content?.forEach(visit)
    }
    visit(row)
    const text = courseNodeText(row)
    if (at !== null && text.trim()) notes.push({ rowId: typeof row.attrs?.id === 'string' ? row.attrs.id : null, text, t: at })
  }
  return notes
}

/** 把模型漏掉的原话作为普通文字节点补回，避免星号、HTML 和实体被再次解释。 */
export function preserveCourseNotes<T extends { body: string; t: number }>(
  rows: T[],
  notes: CourseQuickNote[],
  timestamp?: (t: number) => BlockNode
): (T & { bodyNodes: BlockNode[] })[] {
  const out = rows.map((row) => ({ ...row, bodyNodes: markdownToNodes(row.body) }))
  if (!out.length) return out
  for (const note of notes) {
    const existing = out.find((row) => courseNodeText({ content: row.bodyNodes }).includes(note.text))
    const target = existing ?? out.reduce((best, row) => (Math.abs(row.t - note.t) < Math.abs(best.t - note.t) ? row : best))
    if (!existing)
      target.bodyNodes.push(
        ...note.text
          .split('\n')
          .map((line): BlockNode => ({ type: 'paragraph', ...(line ? { content: [{ type: 'text', text: line }] } : {}) }))
      )
    // 归到相邻要点时，速记仍保留自己的出处时间，不能被该要点的时间替代。
    if (timestamp) target.bodyNodes.push(timestamp(note.t))
  }
  return out
}
