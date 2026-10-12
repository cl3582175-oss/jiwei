import type { ConvertedMarkdown } from '../../lib/importMarkdown'
import { importMarkdown } from '../../lib/importMarkdown'
import { posix } from 'path'
import type { DocNode } from '@shared/types'
export function stripNotionId(name: string): string {
  return name.replace(/ [a-f\d]{32}(?=\.[^.]+$|$)/i, '')
}
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'),
    out: string[][] = []
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false
  const field = (): void => {
    row.push(cell)
    cell = ''
    closed = false
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          quoted = false
          closed = true
        }
      } else cell += c
    } else if (c === ',') field()
    else if (c === '\n') {
      field()
      out.push(row)
      row = []
    } else if (c === '"') {
      if (cell || closed) throw new Error('Invalid CSV quote')
      quoted = true
    } else if (closed && !/[ \t]/.test(c)) throw new Error('Invalid CSV trailing text')
    else if (!closed) cell += c
  }
  if (quoted) throw new Error('Unclosed CSV field')
  if (cell || row.length || closed) {
    field()
    out.push(row)
  }
  return out
}
export function convertNotion(text: string, path: string, pages: string[]): ConvertedMarkdown {
  const result = importMarkdown(/\.csv$/i.test(path) ? '' : text, path)
  const fallback = posix.basename(path).replace(/\.[^.]+$/, '')
  if (result.title === fallback) result.title = stripNotionId(result.title)
  if (!/\.csv$/i.test(path)) return result
  const rows = parseCsv(text),
    header = rows.shift() ?? []
  if (!header.length) return result
  const width = Math.min(12, header.length)
  if (header.length > 12) result.issues.push('extra-columns')
  const folder = posix.join(posix.dirname(path), posix.basename(path).replace(/\.csv$/i, '')) + '/'
  const cell = (value: string, type: string, target?: string): DocNode => {
    const content: DocNode[] = value
      .split('\n')
      .flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])])
    if (target) {
      const encoded = posix.relative(posix.dirname(path), target).split('/').map(encodeURIComponent).join('/')
      const index = result.refs.push({ kind: 'note', target: encoded, label: value, wiki: false }) - 1
      for (const n of content) if (n.type === 'text') n.marks = [{ type: 'link', attrs: { href: `jiwei://import/${index}` } }]
    }
    return { type, content: [{ type: 'paragraph', ...(content.length ? { content } : {}) }] }
  }
  const table: DocNode = {
    type: 'table',
    content: [
      { type: 'tableRow', content: header.slice(0, width).map((v) => cell(v, 'tableHeader')) },
      ...rows.map((row) => {
        const candidates = pages.filter(
          (p) =>
            p.startsWith(folder) &&
            !p.slice(folder.length).includes('/') &&
            stripNotionId(posix.basename(p).replace(/\.(md|markdown|txt)$/i, '')) === row[0]
        )
        if (candidates.length > 1 && !result.issues.includes('ambiguous')) result.issues.push('ambiguous')
        return {
          type: 'tableRow',
          content: Array.from({ length: width }, (_, i) =>
            cell(row[i] ?? '', 'tableCell', i === 0 && candidates.length === 1 ? candidates[0] : undefined)
          )
        }
      })
    ]
  }
  if (rows.some((row) => row.length !== header.length)) result.issues.push('csv-columns')
  result.doc.content![0].content![1].content = [table]
  return result
}
