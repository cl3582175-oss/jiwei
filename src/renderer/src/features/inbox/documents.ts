import { Editor } from '@tiptap/core'
import Collaboration, { isChangeOrigin } from '@tiptap/extension-collaboration'
import { yUndoPluginKey } from '@tiptap/y-tiptap'
import * as Y from 'yjs'
import type { Proposal } from '@shared/types'
import { DOC_FIELD } from '@shared/types'
import { api } from '@/lib/utils'
import { schemaExtensions, idExtension } from '../notes/editor/extensions'
import { OriginAttribute } from '../notes/editor/origin'
import { Embed } from '../notes/editor/embeds/EmbedNode'
import { applyOp } from '../notes/editor/applyProposal'

// 收件箱使用同一编辑器事务和 UndoManager；打开目的笔记时移交会话，⌘Z 仍能撤销归档。
const retained = new Map<string, Y.Doc>()
const undoManagers = new WeakMap<Y.Doc, Y.UndoManager>()
export function inboxUndoManager(doc: Y.Doc): Y.UndoManager | undefined {
  const previous = undoManagers.get(doc)
  if (!previous) return undefined
  // 编辑器销毁会解绑 UndoManager，必须重新建立监听；仅移交栈不能复用已销毁的管理器。
  previous.destroy()
  const manager = new Y.UndoManager(doc.getXmlFragment(DOC_FIELD), {
    trackedOrigins: new Set(previous.trackedOrigins),
    deleteFilter: previous.deleteFilter,
    captureTransaction: previous.captureTransaction
  })
  manager.undoStack = previous.undoStack
  manager.redoStack = previous.redoStack
  undoManagers.set(doc, manager)
  return manager
}
export function takeInboxDocument(noteId: string): Y.Doc | undefined {
  const doc = retained.get(noteId)
  retained.delete(noteId)
  return doc
}
let queue: Promise<unknown> = Promise.resolve()
export function applyInboxDocument(noteId: string, proposalId: string): Promise<void> {
  const run = queue.then(() => apply(noteId, proposalId))
  queue = run.catch(() => undefined)
  return run
}
async function apply(noteId: string, proposalId: string): Promise<void> {
  const proposal = (await api.proposals.list(noteId)).find((p) => p.id === proposalId)
  if (!proposal) return
  const doc = retained.get(noteId) ?? new Y.Doc()
  Y.applyUpdate(doc, await api.notes.loadDoc(noteId))
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      ...schemaExtensions({ summary: '', cueHint: '', bodyHint: '', summaryHint: '' }),
      Collaboration.configure({ document: doc, field: DOC_FIELD, yUndoOptions: { undoManager: inboxUndoManager(doc) } }),
      idExtension((tr) => !isChangeOrigin(tr)),
      OriginAttribute,
      Embed.configure({ ydoc: doc })
    ]
  })
  try {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
    const first = doc.getXmlFragment(DOC_FIELD).get(0)
    if (first instanceof Y.XmlElement && editor.state.doc.firstChild?.attrs.id !== first.getAttribute('id'))
      throw new Error('Editor not synchronized')
    await applyInboxToEditor(editor, doc, proposal)
    undoManagers.set(doc, yUndoPluginKey.getState(editor.state).undoManager)
    retained.set(noteId, doc)
  } finally {
    editor.destroy()
  }
}
export async function applyInboxToEditor(editor: Editor, doc: Y.Doc, proposal: Proposal): Promise<void> {
  for (let index = 0; index < proposal.ops.length; index++) {
    let applied = false
    editor.state.doc.forEach((n) => {
      try {
        const origin = JSON.parse(String(n.attrs.origin)) as { proposalId?: string; opIndex?: number }
        if (origin.proposalId === proposal.id && origin.opIndex === index) applied = true
      } catch {
        /* 用户原有的行没有提案标记 */
      }
    })
    if (!applied) applyOp(editor, doc, proposal, proposal.ops[index])
  }
  // 提交与重试都发送 CRDT 状态增量；主进程合并，绝不替换并发编辑。
  await api.inbox.complete(proposal.id, new Uint8Array(Y.encodeStateAsUpdate(doc)))
}
