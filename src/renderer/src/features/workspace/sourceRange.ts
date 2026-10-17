import type { SourceSelector } from '@shared/sourceTarget'
import { locateQuote } from '../annotate/anchor'

/** Map visual line breaks back to DOM offsets, including PDF.js BR nodes. */
export function sourceRange(root: HTMLElement, selector: SourceSelector): Range | null {
  if (!selector.quote) return null
  let text = ''
  const pieces: { node: Text; start: number; end: number }[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node instanceof Element) {
        if (selector.page && node.matches('.page[data-page-number]')) {
          const page = Number(node.getAttribute('data-page-number'))
          if (page < selector.page || page > (selector.pageEnd ?? selector.page)) return NodeFilter.FILTER_REJECT
        }
        if (node.matches('[data-jiwei-ui], button, script, style, .canvasWrapper, .annotationLayer, .annotationEditorLayer'))
          return NodeFilter.FILTER_REJECT
        return node.matches('br, p, h1, h2, h3, pre, .textLayer') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
      }
      return NodeFilter.FILTER_ACCEPT
    }
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text) {
      const start = text.length
      text += node.data
      pieces.push({ node, start, end: text.length })
    } else if (text && !text.endsWith('\n')) text += '\n'
  }
  const found = locateQuote(text, selector, true)
  if (!found) return null
  const first = pieces.find((p) => p.end > found.start)
  const last = pieces
    .slice()
    .reverse()
    .find((p) => p.start < found.end)
  if (!first || !last) return null
  const range = document.createRange()
  range.setStart(first.node, Math.max(0, found.start - first.start))
  range.setEnd(last.node, Math.min(last.node.length, found.end - last.start))
  return range
}

/** Keep an exact source range visible until another navigation or the reader closes. */
export function paintSourceRange(root: HTMLElement, selector: SourceSelector, scroll = true): (() => void) | null {
  const range = sourceRange(root, selector)
  if (!range || !range.getClientRects().length) return null
  const highlight = new Highlight(range)
  CSS.highlights.set('jw-source-target', highlight)
  if (scroll) range.startContainer.parentElement?.scrollIntoView({ block: 'center' })
  return () => {
    if (CSS.highlights.get('jw-source-target') === highlight) CSS.highlights.delete('jw-source-target')
  }
}
