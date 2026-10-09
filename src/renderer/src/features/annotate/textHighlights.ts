import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Annotation } from '@shared/types'
import { locateQuote, rangeIn } from './anchor'
import { useAnnotate } from './store'

// 文字资料、转写稿的高亮：浏览器的 CSS Custom Highlight API（::highlight），不改动 DOM。
// 每个颜色一个 Highlight；同一时刻可能有多个视图注册（以 key 区分），统一重绘。

interface Entry {
  id: string
  color: string
  question: boolean
  range: Range
}

const registry = new Map<string, Entry[]>()

function repaint(): void {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return
  const groups = new Map<string, Range[]>()
  const add = (name: string, r: Range): void => void groups.set(name, [...(groups.get(name) ?? []), r])
  for (const list of registry.values())
    for (const e of list) {
      add(`jw-${e.color}`, e.range)
      if (e.question) add('jw-question', e.range)
    }
  for (const name of ['jw-yellow', 'jw-green', 'jw-blue', 'jw-pink', 'jw-question']) {
    const ranges = groups.get(name)
    if (ranges?.length) CSS.highlights.set(name, new Highlight(...ranges))
    else CSS.highlights.delete(name)
  }
}

/** 光标位置（点击处）是否落在某个范围内 */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }
  const p = doc.caretPositionFromPoint?.(x, y)
  if (p) return { node: p.offsetNode, offset: p.offset }
  const r = document.caretRangeFromPoint?.(x, y)
  return r ? { node: r.startContainer, offset: r.startOffset } : null
}

/**
 * 在 root 中绘制批注高亮，并处理点击（打开批注卡片）。
 * ownerAttr：片段所在元素的属性（资料为 data-segment）。返回失去定位的批注 ID。
 */
export function useTextHighlights(
  key: string,
  root: RefObject<HTMLElement | null>,
  list: Annotation[],
  version: unknown,
  ownerAttr = 'data-segment'
): string[] {
  const entries = useRef<Entry[]>([])
  const [orphans, setOrphans] = useState<string[]>([])

  useEffect(() => {
    const el = root.current
    if (!el) return
    const out: Entry[] = []
    const lost: string[] = []
    const owners = [...el.querySelectorAll<HTMLElement>(`[${ownerAttr}]`)]
    for (const a of list) {
      const sel = a.selector
      if (!sel.quote) continue
      // 先在原片段中找，找不到再在全部片段中找（资料重新解析后片段可能变化）
      const first = sel.ownerId ? owners.find((o) => o.getAttribute(ownerAttr) === sel.ownerId) : undefined
      let range: Range | null = null
      for (const o of first ? [first, ...owners.filter((x) => x !== first)] : owners) {
        const pos = locateQuote(o.textContent ?? '', o === first ? sel : { ...sel, start: undefined })
        if (pos) {
          range = rangeIn(o, pos.start, pos.end)
          if (range) break
        }
      }
      if (range) out.push({ id: a.id, color: a.color ?? 'yellow', question: a.motivation === 'questioning', range })
      else lost.push(a.id)
    }
    entries.current = out
    registry.set(key, out)
    repaint()
    setOrphans((prev) => (prev.join() === lost.join() ? prev : lost))
    return () => {
      registry.delete(key)
      repaint()
    }
  }, [key, root, list, version, ownerAttr])

  // 点击高亮：打开批注卡片（有选区时是在选文字，不处理）
  useEffect(() => {
    const el = root.current
    if (!el) return
    const onClick = (e: MouseEvent): void => {
      if (!window.getSelection()?.isCollapsed) return
      if ((e.target as HTMLElement).closest('button, a, input, textarea')) return
      const c = caretAt(e.clientX, e.clientY)
      if (!c) return
      const hit = entries.current.find((x) => {
        try {
          if (!x.range.isPointInRange(c.node, c.offset)) return false
        } catch {
          return false
        }
        // 光标落在范围边界时，用矩形确认确实点在高亮上
        return [...x.range.getClientRects()].some((r) => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)
      })
      if (!hit) return
      const a = list.find((x) => x.id === hit.id)
      if (!a) return
      const b = hit.range.getBoundingClientRect()
      useAnnotate.getState().open({ id: a.id, targetType: a.targetType, targetId: a.targetId, rect: { x: b.left, y: b.top, w: b.width, h: b.height }, edit: false })
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [root, list])

  return orphans
}
