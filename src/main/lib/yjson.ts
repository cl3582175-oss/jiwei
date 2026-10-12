import * as Y from 'yjs'
import { ID_TYPES } from '@shared/docSchema'
import { DOC_FIELD, EMBEDS_FIELD, type DocJSON, type DocNode } from '@shared/types'
import { newId } from './ids'

// 文档 JSON → Yjs（与 y-prosemirror 的表示一致：元素 → Y.XmlElement，连续文本 → 一个 Y.XmlText）。
// 用于创建示例笔记、导入（.jiwei / Markdown）等不经过编辑器的写入。缺少 ID 的块自动分配 ID。

function marksToAttrs(marks: DocNode['marks']): Record<string, unknown> | undefined {
  if (!marks?.length) return undefined
  return Object.fromEntries(marks.map((m) => [m.type, m.attrs ?? {}]))
}

function toYElement(node: DocNode): Y.XmlElement {
  const el = new Y.XmlElement(node.type ?? 'paragraph')
  const attrs = { ...(node.attrs ?? {}) }
  if (ID_TYPES.includes(node.type ?? '') && !attrs.id) attrs.id = newId()
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v as string)
  // 连续的文本节点合成一个 Y.XmlText，用 delta 一次写入：
  // 尚未挂到文档上的 Y 类型 length 恒为 0，逐段 insert 会把顺序写反
  const children: (Y.XmlElement | Y.XmlText)[] = []
  let delta: { insert: string; attributes: Record<string, unknown> }[] = []
  const flush = (): void => {
    if (!delta.length) return
    const text = new Y.XmlText()
    text.applyDelta(delta)
    children.push(text)
    delta = []
  }
  for (const c of node.content ?? []) {
    if (c.type === 'text') delta.push({ insert: c.text ?? '', attributes: marksToAttrs(c.marks) ?? {} })
    else {
      flush()
      children.push(toYElement(c))
    }
  }
  flush()
  if (children.length) el.insert(0, children)
  return el
}

export function jsonToYState(doc: DocJSON, embeds?: Record<string, { kind?: string; data?: unknown }>): Uint8Array {
  const ydoc = new Y.Doc()
  const frag = ydoc.getXmlFragment(DOC_FIELD)
  frag.insert(
    0,
    (doc.content ?? []).map((n) => toYElement(n))
  )
  const toY = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const a = new Y.Array<unknown>()
      a.push(value.map(toY))
      return a
    }
    if (value && typeof value === 'object') {
      const m = new Y.Map<unknown>()
      for (const [key, v] of Object.entries(value)) if (v !== undefined) m.set(key, toY(v))
      return m
    }
    return value
  }
  for (const [id, data] of Object.entries(embeds ?? {})) ydoc.getMap(EMBEDS_FIELD).set(id, toY(data))
  const state = Y.encodeStateAsUpdate(ydoc)
  ydoc.destroy()
  return state
}
