import { parseHTML } from 'linkedom'
import type { DocBlock } from './docBlocks'

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
type TableBlock = Extract<DocBlock, { type: 'table' }>
export const HIDDEN_HTML = 'head,script,style,noscript,template,[hidden],[aria-hidden="true"],[data-jiwei-ui]'

/** 只保留表格语义与跨度，不把来源的脚本、样式或事件属性送入片段。 */
export function tableBlockFromHtml(html: string): TableBlock {
  const { document } = parseHTML(`<html><body>${html}</body></html>`)
  const table = document.querySelector('table')
  if (!table) return { type: 'table', header: null, rows: [] }
  for (const hidden of table.querySelectorAll(HIDDEN_HTML)) hidden.remove()
  // 内层表先转成键值，外层遍历时不会把它的行重复计入。
  for (const nested of [...table.querySelectorAll('table')].reverse()) {
    const parsed = tableBlockFromHtml(nested.outerHTML)
    const text = parsed.rows.length
      ? parsed.rows.map((row) => row.map((v, i) => `${parsed.header?.[i] ?? ''}: ${v}`).join('; ')).join('; ')
      : (parsed.header?.join('; ') ?? '')
    nested.replaceWith(document.createTextNode(` ${text} `))
  }
  const rows = [...table.querySelectorAll('tr')]
    .filter((tr) => tr.closest('table') === table)
    .map((tr) =>
      [...tr.children]
        .filter((c) => /^(TD|TH)$/.test(c.tagName))
        .map((c) => ({
          tag: c.tagName.toLowerCase(),
          text: (c.textContent ?? '').replace(/\s+/g, ' ').trim(),
          colspan: Math.max(1, Number(c.getAttribute('colspan')) || 1),
          rowspan: Math.max(1, Number(c.getAttribute('rowspan')) || 1)
        }))
    )
    .filter((row) => row.some((c) => c.text))
  const result: TableBlock = {
    type: 'table',
    header: rows[0]?.map((c) => c.text) ?? null,
    rows: rows.slice(1).map((row) => row.map((c) => c.text))
  }
  const caption = table.querySelector('caption')?.textContent?.trim()
  if (caption) result.caption = caption
  if (rows.some((row) => row.some((c) => c.colspan >= 2 || c.rowspan >= 2)))
    result.html = `<table>${rows.map((row) => `<tr>${row.map((c) => `<${c.tag}${c.colspan >= 2 ? ` colspan="${c.colspan}"` : ''}${c.rowspan >= 2 ? ` rowspan="${c.rowspan}"` : ''}>${escape(c.text)}</${c.tag}>`).join('')}</tr>`).join('')}</table>`
  return result
}

/** 超长合并表格分段前展开跨度，让每一行独立保留键与值的对应关系。 */
export function expandedTableBlockFromHtml(html: string): TableBlock {
  const { document } = parseHTML(`<html><body>${html}</body></html>`)
  const table = document.querySelector('table')
  if (!table) return { type: 'table', header: null, rows: [] }
  const rows = [...table.querySelectorAll('tr')].filter((r) => r.closest('table') === table)
  const grid: string[][] = rows.map(() => [])
  rows.forEach((row, r) => {
    let column = 0
    for (const cell of [...row.children].filter((c) => /^(TD|TH)$/.test(c.tagName))) {
      while (grid[r][column] !== undefined) column++
      const across = Math.min(1000, Math.max(1, Number(cell.getAttribute('colspan')) || 1))
      const down = Math.min(rows.length - r, Math.max(1, Number(cell.getAttribute('rowspan')) || 1))
      for (let y = r; y < r + down; y++) for (let x = column; x < column + across; x++) grid[y][x] = cell.textContent ?? ''
      column += across
    }
  })
  return {
    type: 'table',
    header: grid[0] ?? null,
    rows: grid.slice(1),
    html: `<table>${grid
      .map(
        (row, i) =>
          `<tr>${row
            .map((text) => {
              const tag = i ? 'td' : 'th'
              return `<${tag}>${escape(text)}</${tag}>`
            })
            .join('')}</tr>`
      )
      .join('')}</table>`
  }
}
