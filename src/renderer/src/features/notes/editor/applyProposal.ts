import type { Editor } from '@tiptap/react'
import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import type * as Y from 'yjs'
import type { Origin, Proposal, ProposalOp } from '@shared/types'
import { CORNELL } from './cornell'
import { PROPOSAL_META } from './origin'
import { writeEmbed } from './embeds/ydata'

// 把 AI 提案中的一条操作应用到编辑器：
//   - 以块 ID 定位（行 / 段落 / 富内容块）
//   - 新内容标记为 AI 来源（模型、时间、依据）
//   - 新块重新分配 ID（由 UniqueID 完成），富内容块的数据以新 ID 写入 Yjs
//   - 走正常事务：可撤销、可协同

function findById(doc: PMNode, id: string): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null
  doc.descendants((node, pos) => {
    if (found) return false
    if (node.attrs.id === id) {
      found = { node, pos }
      return false
    }
    return true
  })
  return found
}

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; [k: string]: unknown }

/** 清除 ID（让编辑器重新分配）、写入来源；富内容块换新 ID 并写入数据 */
function prepare(nodes: unknown[], origin: string, proposal: Proposal, ydoc: Y.Doc): Json[] {
  const walk = (n: Json, top: boolean): Json => {
    const attrs: Record<string, unknown> = { ...(n.attrs ?? {}) }
    if (n.type === 'embed') {
      const oldId = String(attrs.id ?? '')
      const payload = proposal.embeds[oldId]
      const newId = crypto.randomUUID()
      if (payload) writeEmbed(ydoc, newId, payload.kind, payload.data)
      attrs.id = newId
      attrs.kind = payload?.kind ?? attrs.kind
    } else {
      delete attrs.id
    }
    if (top || n.type === 'embed') attrs.origin = origin
    return { ...n, attrs, ...(n.content ? { content: n.content.map((c) => walk(c, false)) } : {}) }
  }
  return (nodes as Json[]).map((n) => walk(n, true))
}

const toNodes = (schema: Schema, json: Json[]): PMNode[] => json.map((j) => schema.nodeFromJSON(j))

export class ProposalTargetMissing extends Error {}

/** 是否含有图片、富内容块等无文字的内容 */
function hasLeaf(node: PMNode): boolean {
  let found = false
  node.descendants((n) => {
    if (n.type.name === 'image' || n.type.name === 'embed' || n.type.name === 'horizontalRule') found = true
    return !found
  })
  return found
}

/** 应用一条提案操作；返回新写入的块 ID（用于之后判断用户有没有改写它，学习技能偏好） */
export function applyOp(editor: Editor, ydoc: Y.Doc, proposal: Proposal, op: ProposalOp): string[] {
  const { state, view } = editor
  const schema = state.schema
  const origin: Origin = { by: 'ai', model: proposal.model ?? undefined, at: Date.now(), sources: proposal.sources ?? undefined }
  const originStr = JSON.stringify(origin)
  const tr = state.tr.setMeta(PROPOSAL_META, true)
  const doc = state.doc
  const summaryPos = doc.content.size - doc.lastChild!.nodeSize

  switch (op.op) {
    case 'insert_after': {
      const t = findById(doc, op.blockId)
      if (!t) throw new ProposalTargetMissing(op.blockId)
      const nodes = toNodes(schema, prepare(op.nodes, originStr, proposal, ydoc))
      if (t.node.type.name === CORNELL.row) {
        // 目标是整行：插入到该行笔记栏末尾
        const body = t.node.child(1)
        tr.insert(t.pos + 1 + t.node.child(0).nodeSize + body.nodeSize - 1, nodes)
      } else {
        tr.insert(t.pos + t.node.nodeSize, nodes)
      }
      break
    }
    case 'insert_row': {
      let at = summaryPos
      // 空白笔记（只有一行且为空）：直接替换这一行，不留空行
      const only = doc.childCount === 2 ? doc.firstChild! : null
      const blank = !!only && only.type.name === CORNELL.row && only.textContent === '' && !hasLeaf(only)
      const replaceBlank = blank && !op.afterRowId
      if (op.afterRowId) {
        const t = findById(doc, op.afterRowId)
        if (!t) throw new ProposalTargetMissing(op.afterRowId)
        at = t.pos + t.node.nodeSize
      }
      const para = { type: 'paragraph' }
      const cue = prepare(op.cue.length ? op.cue : [para], originStr, proposal, ydoc)
      const body = prepare(op.body.length ? op.body : [para], originStr, proposal, ydoc)
      const row = schema.nodeFromJSON({
        type: CORNELL.row,
        attrs: { origin: originStr },
        content: [
          { type: CORNELL.cue, content: cue },
          { type: CORNELL.body, content: body }
        ]
      })
      // 一步替换（先删除会让文档暂时没有行，ProseMirror 会自动补一个空行）
      if (replaceBlank) tr.replaceWith(0, only!.nodeSize, row)
      else tr.insert(at, row)
      break
    }
    case 'append_summary': {
      const nodes = toNodes(schema, prepare(op.nodes, originStr, proposal, ydoc))
      const summary = doc.lastChild!
      // 总结只有一个空段落时直接替换，避免留下空行
      if (summary.childCount === 1 && summary.firstChild!.type.name === 'paragraph' && summary.firstChild!.content.size === 0) {
        tr.replaceWith(summaryPos + 1, summaryPos + 1 + summary.firstChild!.nodeSize, nodes)
      } else {
        tr.insert(doc.content.size - 1, nodes)
      }
      break
    }
    case 'replace_block': {
      const t = findById(doc, op.blockId)
      if (!t) throw new ProposalTargetMissing(op.blockId)
      tr.replaceWith(t.pos, t.pos + t.node.nodeSize, toNodes(schema, prepare(op.nodes, originStr, proposal, ydoc)))
      break
    }
    case 'delete_block': {
      const t = findById(doc, op.blockId)
      if (!t) throw new ProposalTargetMissing(op.blockId)
      let rows = 0
      doc.forEach((n) => n.type.name === CORNELL.row && rows++)
      if (t.node.type.name === CORNELL.row && rows <= 1) throw new Error('Cannot delete the only row')
      // 容器中唯一的块：换成空段落，保持结构合法
      const parent = doc.resolve(t.pos).parent
      if (t.node.type.name !== CORNELL.row && parent.childCount === 1)
        tr.replaceWith(t.pos, t.pos + t.node.nodeSize, schema.nodes.paragraph.create())
      else tr.delete(t.pos, t.pos + t.node.nodeSize)
      break
    }
  }
  view.dispatch(tr.scrollIntoView())
  // 编辑器在同一次分发中为新节点分配 ID；本次写入的顶层节点带有同一个来源字符串
  const ids: string[] = []
  editor.state.doc.descendants((n) => {
    if (n.attrs.origin === originStr && typeof n.attrs.id === 'string') ids.push(n.attrs.id)
    return true
  })
  return ids
}
