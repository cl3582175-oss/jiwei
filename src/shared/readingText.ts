/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { ReadingParagraph } from './reading'

export const READING_STYLE_VERSION = 'faithful-v3'
export const READING_MAX_PARAGRAPHS = 20
export const READING_MAX_CHARACTERS = 3000
export const READING_CACHE_BYTES = 50 * 1024 * 1024
export const JIWEI_UI_ATTRIBUTE = 'data-jiwei-ui'

/** 同一字符判定用于资料、网页与选区；语言标签只是线索，正文优先。 */
export function readingLanguage(text: string, declared?: string | null): string {
  const letters = text.match(/\p{L}/gu) ?? [], cjk = text.match(/[\u3400-\u9fff]/g) ?? []
  if (letters.length && cjk.length / letters.length > 0.35) return 'zh'
  const language = declared?.toLowerCase().split(/[-_]/)[0]
  if (language && language !== 'und' && !(language === 'zh' && letters.length > 20 && cjk.length === 0)) return language
  if (/[\u3040-\u30ff]/.test(text)) return 'ja'
  if (/[\uac00-\ud7af]/.test(text)) return 'ko'
  if (/[\u0400-\u04ff]/.test(text)) return 'ru'
  return /[A-Za-z]/.test(text) ? 'en' : 'und'
}
export function isForeignText(text: string, uiLanguage: string, declared?: string | null): boolean {
  const language = readingLanguage(text, declared)
  return language !== 'und' && language !== uiLanguage.split(/[-_]/)[0].toLowerCase()
}
export function normalizedReadingText(text: string): string { return text.normalize('NFKC').replace(/\s+/g, ' ').trim() }

/** 大段（如 PDF 页）沿已有分段再切小块，任何请求都遵守成本批次上限。 */
export function readingParts(text: string, max = 2400): string[] {
  const parts: string[] = []
  let pending = ''
  for (const line of text.split(/\n\s*\n/)) {
    const clean = line.trim()
    if (!clean) continue
    if (pending && pending.length + clean.length + 2 > max) { parts.push(pending); pending = '' }
    let rest = clean
    while (rest.length > max) {
      // 优先在句末切（v0.6.5 实测：在空格处切会让译文停在半句话上）。
      const head = rest.slice(0, max), sentence = Math.max(...[...head.matchAll(/[.!?。！？]["'”’)]?\s/g)].map((m) => m.index + m[0].length - 1), -1)
      const stop = sentence > max / 2 ? sentence : head.lastIndexOf(' ')
      const end = stop > max / 2 ? stop + 1 : max
      parts.push(rest.slice(0, end).trim()); rest = rest.slice(end).trim()
    }
    pending += `${pending ? '\n\n' : ''}${rest}`
  }
  if (pending) parts.push(pending)
  return parts
}
export function readingBatches<T extends ReadingParagraph>(paragraphs: T[]): T[][] {
  const batches: T[][] = []; let batch: T[] = [], characters = 0
  for (const p of paragraphs) {
    if (!p.text.trim() || p.text.length > READING_MAX_CHARACTERS) continue
    if (batch.length && (batch.length === READING_MAX_PARAGRAPHS || characters + p.text.length > READING_MAX_CHARACTERS)) {
      batches.push(batch); batch = []; characters = 0
    }
    batch.push(p); characters += p.text.length
  }
  if (batch.length) batches.push(batch)
  return batches
}

export const READING_PARAGRAPH_SELECTOR = 'p,li,blockquote,h1,h2,h3,h4,h5,h6,td,figcaption,jiwei-para'
const READING_EXCLUDED_SELECTOR = '[data-jiwei-ui],nav,footer,header,aside,button,input,textarea,select,pre,code,script,style,template,[hidden],[aria-hidden="true"],[role="navigation"],math,.katex,.MathJax,[class*="mathjax"]'
const INLINE = /^(?:#text|A|ABBR|B|BDI|BDO|CITE|DFN|EM|FONT|I|KBD|MARK|Q|S|SAMP|SMALL|SPAN|STRONG|SUB|SUP|TIME|U|VAR|WBR|IMG)$/
/** 有些网页（如 paulgraham.com）整篇文章是一个元素，段落之间只用 <br><br> 分开。
 *  把每段包进一个行内的 <jiwei-para>，对照阅读才能逐段插入译文。只改结构不改文字，批注与存为资料不受影响。 */
export function splitBreakParagraphs(root: ParentNode, minimum = 300): void {
  const parents = new Set<Element>()
  root.querySelectorAll('br + br').forEach((br) => { if (br.parentElement && !br.parentElement.closest(READING_EXCLUDED_SELECTOR)) parents.add(br.parentElement) })
  for (const parent of parents) {
    if (parent.querySelector(':scope > jiwei-para') || (parent.textContent ?? '').length < minimum) continue
    const runs: Node[][] = [[]]
    const nodes = [...parent.childNodes]
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (node.nodeName === 'BR') {
        let j = i + 1
        while (j < nodes.length && nodes[j].nodeType === 3 && !nodes[j].textContent!.trim()) j++
        if (nodes[j]?.nodeName === 'BR') { runs.push([]); continue }
      }
      runs[runs.length - 1].push(node)
    }
    const paragraphs = runs.filter((run) => run.some((n) => (n.textContent ?? '').trim()) && run.every((n) => INLINE.test(n.nodeName) || n.nodeName === 'BR'))
    if (paragraphs.length < 2) continue
    for (const run of paragraphs) {
      const first = run.find((n) => (n.textContent ?? '').trim() || n.nodeName !== '#text'), last = [...run].reverse().find((n) => (n.textContent ?? '').trim() || n.nodeName !== '#text')
      if (!first || !last) continue
      const wrapper = parent.ownerDocument.createElement('jiwei-para')
      parent.insertBefore(wrapper, first)
      for (let node: Node | null = first; node; ) { const next: Node | null = node === last ? null : node.nextSibling; wrapper.appendChild(node); node = next }
    }
  }
}
export function readingParagraphs(root: ParentNode, visible: (element: Element) => boolean = () => true): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(READING_PARAGRAPH_SELECTOR)].filter((element) => {
    if (element.closest(READING_EXCLUDED_SELECTOR) || !visible(element)) return false
    // 嵌套列表/引用的父节点不再发一次相同正文。
    if (element.querySelector(READING_PARAGRAPH_SELECTOR)) return false
    return normalizedReadingText(originalReadingText(element)).length >= 2
  })
}
export function originalReadingText(node: Node): string {
  const copy = node.cloneNode(true)
  if (copy.nodeType === 1 && (copy as Element).hasAttribute(JIWEI_UI_ATTRIBUTE)) return ''
  if ('querySelectorAll' in copy) (copy as ParentNode).querySelectorAll(`[${JIWEI_UI_ATTRIBUTE}]`).forEach((ui) => ui.remove())
  return copy.textContent ?? ''
}
/** 从仍连接的原文节点读取，过滤隐藏祖先；索引中的偏移始终映射回同一文字节点。 */
export function originalTextIndex(root: Node, range?: Range): { text: string; nodes: { node: Text; start: number; raw: string; offset: number }[] } {
  const index = { text: '', nodes: [] as { node: Text; start: number; raw: string; offset: number }[] }
  if (range?.collapsed) return index
  const styles = new WeakMap<Element, CSSStyleDeclaration>(), hidden = new WeakMap<Element, boolean>()
  const style = (element: Element): CSSStyleDeclaration => {
    let css = styles.get(element)
    if (!css) { css = element.ownerDocument.defaultView!.getComputedStyle(element); styles.set(element, css) }
    return css
  }
  const readingOriginal = (element: Element): boolean => element.matches(READING_PARAGRAPH_SELECTOR) && !!element.nextElementSibling?.matches('jiwei-reading[data-jiwei-ui][data-mode="translation"]')
  const unrendered = (element: Element | null): boolean => {
    if (!element) return false
    if (!hidden.has(element)) hidden.set(element, element.matches('[data-jiwei-ui],script,style,noscript,template,[hidden],[aria-hidden="true"]') || (style(element).display === 'none' && !readingOriginal(element)) || unrendered(element.parentElement))
    return hidden.get(element)!
  }
  const blocks = new Set(['block', 'flow-root', 'flex', 'grid', 'list-item', 'table', 'table-row', 'table-caption'])
  let boundary = ''
  const separate = (value: string): void => { if (value === '\n' || !boundary) boundary = value }
  const append = (text: string, node?: Text): void => {
    if (!text) return
    if (boundary && index.text && !/\s$/.test(index.text) && !/^\s/.test(text)) index.text += boundary
    boundary = ''
    if (node) index.nodes.push({ node, start: index.text.length, raw: text, offset: range?.startContainer === node ? range.startOffset : 0 })
    index.text += text
  }
  const visit = (node: Node): void => {
    if (range && !range.intersectsNode(node)) return
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement
      if (parent && (unrendered(parent) || ['hidden', 'collapse'].includes(style(parent).visibility))) return
      const text = node as Text
      append(text.data.slice(range?.startContainer === text ? range.startOffset : 0, range?.endContainer === text ? range.endOffset : text.length), text)
      return
    }
    const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : null
    if (element && unrendered(element)) return
    if (node.nodeName === 'BR') { append('\n'); return }
    const display = element ? (readingOriginal(element) ? element.nodeName === 'TD' ? 'table-cell' : 'block' : style(element).display) : ''
    const separator = blocks.has(display) ? '\n' : display === 'table-cell' ? '\t' : ''
    if (separator) separate(separator)
    node.childNodes.forEach(visit)
    if (separator) separate(separator)
  }
  visit(root)
  return index
}
export function originalRangeText(range: Range): string {
  return originalTextIndex(range.commonAncestorContainer, range).text
}

/** 预埋的隐藏登录弹窗不应关闭正文 AI；可见密码框仍立即触发隐私边界。 */
export function visibleReadingPassword(element: Element): boolean {
  const rect=element.getBoundingClientRect()
  if(rect.width<=2 || rect.height<=2 || element.getClientRects().length===0)return false
  for(let parent:Element|null=element;parent;parent=parent.parentElement) {
    const css=getComputedStyle(parent)
    if(parent.hasAttribute('hidden') || parent.getAttribute('aria-hidden')==='true' || css.display==='none' || css.visibility==='hidden' || css.visibility==='collapse' || Number(css.opacity)<=0.05)return false
  }
  return true
}
