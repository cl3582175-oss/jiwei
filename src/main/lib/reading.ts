import { createHash } from 'crypto'
import { parseHTML } from 'linkedom'
import { normalizedReadingText } from '@shared/reading'

/** 跟 URL/资料 ID 无关，重复段落跨来源复用；释义包含词与段落身份。 */
export function readingCacheKey(text: string, targetLanguage: string, styleVersion: string, word?: string): string {
  return createHash('sha256').update(JSON.stringify([normalizedReadingText(text), targetLanguage, styleVersion, word ?? ''])).digest('hex')
}
export function readingTextHash(text: string): string { return createHash('sha256').update(normalizedReadingText(text)).digest('hex') }
export function lruVictims(entries: { id: string; bytes: number; usedAt: number }[], limit: number): string[] {
  let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  const victims: string[] = []
  for (const entry of [...entries].sort((a, b) => a.usedAt - b.usedAt)) {
    if (bytes <= limit) break
    victims.push(entry.id); bytes -= entry.bytes
  }
  return victims
}
export function cleanReadingHtml(html: string): string {
  const { document } = parseHTML(html)
  document.querySelectorAll('[data-jiwei-ui]').forEach((node) => node.remove())
  return document.toString()
}

/**
 * Readability 正文或原始 body 的规范可见文本：块、BR、表格行/单元格保留为空格边界，
 * 内联节点直接连接。只折叠空白，不改变 Unicode、标点、公式或词语；与网页 quote 契约一致。
 */
export function readingHtmlText(html: string): string {
  const { document } = parseHTML(html)
  const blocks = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CAPTION', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL'])
  const text = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? ''
    if (node.nodeType === 1 && (node as Element).matches('head,script,style,noscript,template,[data-jiwei-ui],[hidden],[aria-hidden="true"]')) return ''
    if (node.nodeName === 'BR') return ' '
    const content = Array.from(node.childNodes, text).join('')
    return blocks.has(node.nodeName) ? ` ${content} ` : content
  }
  return text(document.querySelector('body') ?? document).replace(/\s+/g, ' ').trim()
}
