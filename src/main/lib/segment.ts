// 文本分段（纯函数）：Markdown 按标题与空行分段，纯文本按空行分段。
// 定位使用 W3C TextPositionSelector（字符偏移），重新解析时可稳定对齐。
import { chunkBlocks, type ChunkOut } from './chunker'
import { structuredTextBlocks } from './structuredText'
import type { DocBlock } from './docBlocks'

export interface TextSegment {
  kind: 'heading' | 'paragraph' | 'code'
  locator: { type: 'TextPositionSelector'; start: number; end: number }
  text: string
}

const MAX_SEGMENT = 2000

export function segmentText(raw: string, mode: 'markdown' | 'plain'): TextSegment[] {
  const text = raw.replace(/\r\n?/g, '\n')
  const out: TextSegment[] = []
  let i = 0
  const push = (kind: TextSegment['kind'], start: number, end: number): void => {
    const body = text.slice(start, end).trim()
    if (!body) return
    // 超长段落按句号切开，避免单个片段过大
    if (body.length > MAX_SEGMENT) {
      let s = start
      while (s < end) {
        let e = Math.min(end, s + MAX_SEGMENT)
        if (e < end) {
          const cut = text.slice(s, e).search(/[。！？.!?]\s*[^。！？.!?]*$/)
          if (cut > MAX_SEGMENT / 2) e = s + cut + 1
        }
        const part = text.slice(s, e).trim()
        if (part) out.push({ kind, locator: { type: 'TextPositionSelector', start: s, end: e }, text: part })
        s = e
      }
      return
    }
    out.push({ kind, locator: { type: 'TextPositionSelector', start, end }, text: body })
  }

  while (i < text.length) {
    if (mode === 'markdown' && text.startsWith('```', i)) {
      const close = text.indexOf('\n```', i + 3)
      const end = close === -1 ? text.length : text.indexOf('\n', close + 4) === -1 ? text.length : text.indexOf('\n', close + 4)
      push('code', i, end)
      i = end + 1
      continue
    }
    const lineEnd = text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i)
    const line = text.slice(i, lineEnd)
    if (mode === 'markdown' && /^#{1,6}\s/.test(line)) {
      push('heading', i, lineEnd)
      i = lineEnd + 1
      continue
    }
    if (!line.trim()) {
      i = lineEnd + 1
      continue
    }
    // 段落：直到空行或（Markdown）标题 / 代码块
    let end = lineEnd
    let j = lineEnd + 1
    while (j < text.length) {
      const le = text.indexOf('\n', j) === -1 ? text.length : text.indexOf('\n', j)
      const l = text.slice(j, le)
      if (!l.trim() || (mode === 'markdown' && (/^#{1,6}\s/.test(l) || l.startsWith('```')))) break
      end = le
      j = le + 1
    }
    push('paragraph', i, end)
    i = end + 1
  }
  return out
}

/** B 线切换文本解析时使用；旧 segmentText 的其他消费者保持原切分。 */
export function segmentTextStructured(raw: string, mode: 'markdown' | 'plain'): ChunkOut[] {
  const positions = new Map<DocBlock, Record<string, unknown>>()
  const blocks: DocBlock[] = []
  const text = raw.replace(/\r\n?/g, '\n')
  const grouped: TextSegment[] = []
  for (const segment of segmentText(raw, mode)) {
    const previous = grouped.at(-1)
    // 旧切分的硬长度界可能落在表格行或代码行中间，先恢复这个块，再作结构切分。
    if (previous && previous.kind === segment.kind && previous.locator.end === segment.locator.start) {
      previous.locator.end = segment.locator.end
      previous.text = text.slice(previous.locator.start, previous.locator.end).trim()
    } else grouped.push({ ...segment, locator: { ...segment.locator } })
  }
  for (const segment of grouped) {
    const next: DocBlock[] = segment.kind === 'code' ? [{ type: 'code', text: segment.text }] : structuredTextBlocks(segment.text)
    for (const b of next) {
      positions.set(b, segment.locator)
      blocks.push(b)
    }
  }
  return chunkBlocks(blocks, { locatorOf: (b) => positions.get(b)! })
}
