import { headingLevel, type DocBlock } from './docBlocks'
import { tableBlockFromHtml } from './tableBlocks'

const cells = (line: string): string[] => {
  const body = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}
const divider = (line: string): boolean => cells(line).every((c) => /^:?-{3,}:?$/.test(c))

/** 识别文字、Markdown 与 Word 纯文本的逐行结构；不执行或保留任意 HTML。 */
export function structuredTextBlocks(text: string): DocBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: DocBlock[] = []
  let pending: string[] = []
  const flush = (): void => {
    if (pending.length) out.push({ type: 'paragraph', text: pending.join('\n') })
    pending = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (/^```/.test(line)) {
      flush()
      const code = [lines[i]]
      while (++i < lines.length) {
        code.push(lines[i])
        if (/^```\s*$/.test(lines[i])) break
      }
      out.push({ type: 'code', text: code.join('\n') })
      continue
    }
    if (/<table\b/i.test(line)) {
      flush()
      const table = [lines[i]]
      while (!/<\/table>/i.test(table.at(-1)!) && ++i < lines.length) table.push(lines[i])
      const block = tableBlockFromHtml(table.join('\n'))
      if (block.header?.some(Boolean) || block.rows.length) out.push(block)
      continue
    }
    if (/^\|/.test(line) && lines[i + 1] && divider(lines[i + 1])) {
      flush()
      const header = cells(line),
        rows: string[][] = []
      i += 1
      while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) rows.push(cells(lines[++i]))
      const block: Extract<DocBlock, { type: 'table' }> = { type: 'table', header, rows }
      const previous = out.at(-1)
      if (previous?.type === 'paragraph' && /^(?:表\s*\d|Table\s+\d)/i.test(previous.text) && previous.text.length <= 90) {
        block.caption = previous.text
        out.pop()
      }
      out.push(block)
      continue
    }
    const md = line.match(/^(#{1,6})\s+(.+)$/)
    const level = md ? md[1].length : headingLevel(line)
    if (!line || level) {
      flush()
      if (level) out.push({ type: 'heading', level, text: md?.[2] ?? line })
    } else pending.push(line)
  }
  flush()
  return out
}
