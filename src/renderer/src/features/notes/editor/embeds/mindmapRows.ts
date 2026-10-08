import type { Editor } from '@tiptap/react'
import type * as Y from 'yjs'
import { MindmapDataSchema, toCornellRows } from '@shared/embeds/mindmap'
import { CORNELL } from '../cornell'
import { PROPOSAL_META } from '../origin'

export /** 思维导图 → 康奈尔行：插入到导图所在行之后，沿用导图的来源标记 */
function mindmapToRows(editor: Editor, entry: Y.Map<unknown>, getPos: () => number | undefined, originAttr: string | null): void {
  const data = MindmapDataSchema.safeParse((entry.get('data') as { toJSON(): unknown }).toJSON())
  const pos = getPos()
  if (!data.success || pos === undefined) return
  const { state, view } = editor
  const $pos = state.doc.resolve(pos)
  let after = state.doc.content.size - state.doc.lastChild!.nodeSize
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === CORNELL.row) {
      after = $pos.after(d)
      break
    }
  }
  // 子块继承来源：AI 生成的导图展开后仍是 AI 内容（直到用户修改）
  const withOrigin = (nodes: unknown[]): unknown[] =>
    originAttr ? nodes.map((n) => ({ ...(n as object), attrs: { ...((n as { attrs?: object }).attrs ?? {}), origin: originAttr } })) : nodes
  const rows = toCornellRows(data.data).map((r) =>
    state.schema.nodeFromJSON({
      type: CORNELL.row,
      attrs: { origin: originAttr },
      content: [
        { type: CORNELL.cue, content: withOrigin(r.cue) },
        { type: CORNELL.body, content: withOrigin(r.body) }
      ]
    })
  )
  const tr = state.tr.insert(after, rows)
  if (originAttr) tr.setMeta(PROPOSAL_META, true)
  view.dispatch(tr.scrollIntoView())
}
