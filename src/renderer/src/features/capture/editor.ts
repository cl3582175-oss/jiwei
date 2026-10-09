import { TextSelection } from '@tiptap/pm/state'
import * as Y from 'yjs'
import { api } from '@/lib/utils'
import type { Editor } from '@tiptap/react'
import type { SelectionBookmark, Transaction } from '@tiptap/pm/state'
import type { CaptureDelivery } from '@shared/capture'
import { useApp } from '@/store/app'
let active: { editor: Editor; noteId: string; ydoc: Y.Doc } | null = null
const snapshots = new Map<string, { editor: Editor; noteId: string; ydoc: Y.Doc; bookmark: SelectionBookmark; unmap: () => void }>()
export function registerCaptureEditor(editor: Editor, noteId: string, ydoc: Y.Doc): () => void {
  active = { editor, noteId, ydoc }
  return () => {
    if (active?.editor === editor) active = null
    for (const [id, s] of snapshots) if (s.editor === editor) releaseCapture(id)
  }
}
export function freezeCapture(id: string): string | null {
  if (!active || active.editor.isDestroyed || useApp.getState().noteId !== active.noteId) return null
  const { editor, noteId, ydoc } = active
  let selection = editor.state.selection
  const dom = editor.view.dom.ownerDocument.getSelection()
  // 原生快捷键可能早于 selectionchange；在捕捉边界通过公开的 DOM 定位 API 同步真实选区。
  if (
    selection instanceof TextSelection &&
    dom?.anchorNode &&
    dom.focusNode &&
    editor.view.dom.contains(dom.anchorNode) &&
    editor.view.dom.contains(dom.focusNode)
  ) {
    const anchor = editor.view.posAtDOM(dom.anchorNode, dom.anchorOffset)
    const head = editor.view.posAtDOM(dom.focusNode, dom.focusOffset)
    if (editor.state.doc.resolve(anchor).parent.inlineContent && editor.state.doc.resolve(head).parent.inlineContent)
      selection = TextSelection.create(editor.state.doc, anchor, head)
  }
  const snapshot = { editor, noteId, ydoc, bookmark: selection.getBookmark(), unmap: () => editor.off('transaction', map) }
  const map = ({ transaction }: { transaction: Transaction }): void => {
    snapshot.bookmark = snapshot.bookmark.map(transaction.mapping)
  }
  editor.on('transaction', map)
  snapshots.set(id, snapshot)
  return noteId
}
export function releaseCapture(id: string): void {
  snapshots.get(id)?.unmap()
  snapshots.delete(id)
}
export async function insertCapture(p: CaptureDelivery): Promise<void> {
  const s = snapshots.get(p.id)
  if (!s || s.editor.isDestroyed || s.noteId !== p.noteId || useApp.getState().noteId !== s.noteId) throw new Error('capture.noNote')
  const content = [
    ...(p.asset && p.image ? [{ type: 'image', attrs: { src: p.asset.url, alt: '' } }] : []),
    ...p.text
      .split('\n')
      .filter(Boolean)
      .map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
    ...p.formulas.filter(Boolean).map((latex) => ({ type: 'blockMath', attrs: { latex } }))
  ]
  const selection = s.bookmark.resolve(s.editor.state.doc)
  const tr = s.editor.state.tr.setSelection(selection).deleteSelection()
  const { $from } = tr.selection
  let at = tr.selection.from
  // 块级图片不能直接塞进段落；先在原光标处分段，再在两段之间插入。
  if ($from.parent.isTextblock) {
    if ($from.parent.content.size === 0) {
      at = $from.before()
      tr.delete(at, $from.after())
    } else if ($from.parentOffset === 0) at = $from.before()
    else if ($from.parentOffset === $from.parent.content.size) at = $from.after()
    else {
      tr.split(at)
      at += 1
    }
  }
  const nodes = content.map((node) => s.editor.schema.nodeFromJSON(node))
  tr.insert(at, nodes)
  tr.doc.check()
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + nodes.reduce((n, node) => n + node.nodeSize, 0))))
  s.editor.view.dispatch(tr)
  // 插入确认必须晚于 CRDT 写入，不能用界面出现冒充持久化成功。
  await api.notes.pushUpdate(s.noteId, new Uint8Array(Y.encodeStateAsUpdate(s.ydoc)))
  s.editor.view.focus()
}
