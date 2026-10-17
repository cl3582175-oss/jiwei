import type { AnnotationSelector } from '@shared/types'
import { normalizeExtracted } from '@shared/textNormalize'

// 文字批注的定位（W3C TextQuote）：资料重新解析或笔记修改后，凭原文与前后文重新找到位置。

/** 在 text 中找到选择器指向的位置；找不到返回 null（批注“失去定位”） */
export function locateQuote(
  text: string,
  sel: Pick<AnnotationSelector, 'quote' | 'prefix' | 'suffix' | 'start' | 'end'>,
  requireUnique = false
): { start: number; end: number } | null {
  const exact = locateExactQuote(text, sel, requireUnique)
  if (exact || !sel.quote) return exact
  const mapped = normalizedOffsets(text),
    quote = normalizedOffsets(sel.quote).text
  if (!quote || (mapped.text === text && quote === sel.quote)) return null
  const found = locateExactQuote(
    mapped.text,
    {
      quote,
      prefix: sel.prefix ? normalizedOffsets(sel.prefix).text : undefined,
      suffix: sel.suffix ? normalizedOffsets(sel.suffix).text : undefined,
      start: sel.start === undefined ? undefined : mapped.starts.findIndex((i) => i >= sel.start!)
    },
    requireUnique
  )
  return found ? { start: mapped.starts[found.start], end: mapped.ends[found.end - 1] } : null
}

function normalizedOffsets(source: string): { text: string; starts: number[]; ends: number[] } {
  let text = '',
    offset = 0
  const starts: number[] = [],
    ends: number[] = []
  for (const ch of source) {
    const start = offset
    offset += ch.length
    const value = normalizeExtracted(ch)
    for (const unit of value.split('')) {
      if (/\s/.test(unit)) {
        if (!text) continue
        if (text.endsWith(' ')) {
          ends[ends.length - 1] = offset
          continue
        }
        text += ' '
      } else text += unit
      starts.push(start)
      ends.push(offset)
    }
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1)
    starts.pop()
    ends.pop()
  }
  return { text, starts, ends }
}

function locateExactQuote(
  text: string,
  sel: Pick<AnnotationSelector, 'quote' | 'prefix' | 'suffix' | 'start' | 'end'>,
  requireUnique: boolean
): { start: number; end: number } | null {
  const q = sel.quote
  if (!q) return null
  // 1. 原位置未变
  if (sel.start !== undefined && text.slice(sel.start, sel.start + q.length) === q) return { start: sel.start, end: sel.start + q.length }
  // 2. 原文出现的所有位置：前后文吻合度高者优先，其次离原位置近
  const hits: number[] = []
  for (let i = text.indexOf(q); i >= 0 && hits.length < 200; i = text.indexOf(q, i + 1)) hits.push(i)
  if (!hits.length) return null
  const score = (i: number): number => {
    let s = 0
    if (sel.prefix) s += common(text.slice(Math.max(0, i - sel.prefix.length), i), sel.prefix, true)
    if (sel.suffix) s += common(text.slice(i + q.length, i + q.length + sel.suffix.length), sel.suffix, false)
    return s
  }
  const ranked = hits
    .map((i) => ({ i, s: score(i), d: sel.start !== undefined ? Math.abs(i - sel.start) : 0 }))
    .sort((a, b) => b.s - a.s || a.d - b.d)
  const best = ranked[0]
  if (requireUnique && ranked[1]?.s === best.s && ranked[1].d === best.d) return null
  return { start: best.i, end: best.i + q.length }
}

/** 共同后缀（前文）或共同前缀（后文）的长度 */
function common(a: string, b: string, fromEnd: boolean): number {
  let n = 0
  while (n < a.length && n < b.length && (fromEnd ? a[a.length - 1 - n] === b[b.length - 1 - n] : a[n] === b[n])) n++
  return n
}

/** 元素内按字符偏移构造 Range（偏移与 Range.toString() 的计数一致） */
export function rangeIn(el: Element, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest('[data-jiwei-ui]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  const r = document.createRange()
  let pos = 0
  let started = false
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.textContent?.length ?? 0
    if (!started && start <= pos + len) {
      r.setStart(n, Math.max(0, start - pos))
      started = true
    }
    if (started && end <= pos + len) {
      r.setEnd(n, Math.max(0, end - pos))
      return r
    }
    pos += len
  }
  return null
}
