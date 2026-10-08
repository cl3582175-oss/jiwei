import type { Editor } from '@tiptap/react'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Anchor } from '@shared/context'
import type { Rect } from '@/features/assist/store'
import { CORNELL } from './cornell'

// 笔记选区 → 锚点：选区覆盖的每个“单元格内顶层块”（段落、标题、列表、引用……）各一个锚点。
// AI 修改以块为单位提交（note_replace_block），块 ID 由锚点带给模型。

const CELLS = new Set<string>([CORNELL.cue, CORNELL.body, CORNELL.summary])

export interface NoteSelection {
  anchors: Anchor[]
  quote: string
  rect: Rect
}

export function noteSelectionTargets(editor: Editor, noteId: string): NoteSelection | null {
  const { state, view } = editor
  const { from, to, empty } = state.selection
  if (empty) return null
  const quote = state.doc.textBetween(from, to, '\n').trim()
  if (!quote) return null
  const anchors: Anchor[] = []
  state.doc.nodesBetween(from, to, (node: PMNode, pos: number, parent: PMNode | null) => {
    if (anchors.length >= 8) return false
    if (parent && CELLS.has(parent.type.name) && typeof node.attrs.id === 'string') {
      const a = Math.max(from, pos)
      const b = Math.min(to, pos + node.nodeSize)
      anchors.push({
        kind: 'note-text',
        parentType: 'note',
        parentId: noteId,
        ownerId: node.attrs.id,
        quote: state.doc.textBetween(a, b, '\n').slice(0, 8000)
      })
      return false
    }
    return true
  })
  const s = view.coordsAtPos(from)
  const e = view.coordsAtPos(to)
  const rect: Rect = { x: Math.min(s.left, e.left), y: s.top, w: Math.abs(e.right - s.left), h: e.bottom - s.top }
  return { anchors, quote, rect }
}
