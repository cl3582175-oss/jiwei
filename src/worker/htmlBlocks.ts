import { parseHTML } from 'linkedom'
import { headingLevel, type DocBlock } from '../main/lib/docBlocks'
import { HIDDEN_HTML, tableBlockFromHtml } from '../main/lib/tableBlocks'

/** Word、保存的 HTML 与 EPUB 共用文档顺序遍历，避免父子块重复抽取。 */
export function htmlBlocks(html: string): DocBlock[] {
  const { document } = parseHTML(/<html\b/i.test(html) ? html : `<html><body>${html}</body></html>`)
  const out: DocBlock[] = []
  const textOf = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? ''
    if (node.nodeType === 1 && (node as Element).matches(HIDDEN_HTML)) return ''
    if (node.nodeName === 'BR') return '\n'
    return [...node.childNodes].map(textOf).join('')
  }
  const clean = (node: Node): string =>
    textOf(node)
      .replace(/[^\S\n]+/g, ' ')
      .replace(/\n+/g, '\n')
      .trim()
  const paragraph = (text: string): void => {
    if (!text) return
    const level = headingLevel(text)
    out.push(level ? { type: 'heading', level, text } : { type: 'paragraph', text })
  }
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      paragraph((node.textContent ?? '').trim())
      return
    }
    if (node.nodeType !== 1) return
    const el = node as Element
    if (el.matches(HIDDEN_HTML)) return
    const tag = el.tagName.toLowerCase()
    if (/^h[1-6]$/.test(tag)) {
      const text = clean(el)
      if (text) out.push({ type: 'heading', level: Number(tag[1]), text })
    } else if (tag === 'table') {
      const block = tableBlockFromHtml(el.outerHTML)
      const previous = out.at(-1)
      if (previous?.type === 'paragraph' && /^(?:表\s*\d|Table\s+\d)/i.test(previous.text) && previous.text.length <= 90) {
        block.caption ??= previous.text
        out.pop()
      }
      if (block.header?.some(Boolean) || block.rows.length) out.push(block)
    } else if (tag === 'ul' || tag === 'ol') {
      const text = [...el.querySelectorAll('li')]
        .filter((li) => li.parentElement === el)
        .map((li) => `- ${clean(li)}`)
        .join('\n')
      if (text) out.push({ type: 'paragraph', text })
    } else if (tag === 'pre') {
      const text = textOf(el)
      if (text.trim()) out.push({ type: 'code', text })
    } else if (['p', 'li', 'blockquote', 'figcaption'].includes(tag)) paragraph(clean(el))
    else [...el.childNodes].forEach(visit)
  }
  ;[...(document.body ?? document).childNodes].forEach(visit)
  return out
}
