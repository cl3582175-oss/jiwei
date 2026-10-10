import { Node, Extension, type CommandProps } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'

// 康奈尔笔记文档模型
//
//   doc
//   ├── cornellRow+        一行 = 一个知识点：左侧线索与右侧笔记横向对齐、互相绑定
//   │   ├── cornellCue     线索（关键词 / 问题）——将来自动成为复习卡片的“问题”
//   │   └── cornellBody    笔记（要点 / 推导 / 例子）——卡片的“答案”
//   └── cornellSummary     总结
//
// 快捷键：⌘/Ctrl+Enter 新增一行；Tab / Shift+Tab 在线索与笔记之间移动；空行首按退格删除该行。
// 结构变化须同步更新 main/lib/derive.ts 与 shared DOC_VERSION。

export const CORNELL = { row: 'cornellRow', cue: 'cornellCue', body: 'cornellBody', summary: 'cornellSummary' } as const

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    cornell: {
      /** 在当前行之后（不在行内时追加到末尾）新增一行，并把光标放到新行的笔记栏 */
      addCornellRow: (opts?: { focus?: 'cue' | 'body' }) => ReturnType
    }
  }
}

export const CornellDocument = Node.create({
  name: 'doc',
  topNode: true,
  content: `${CORNELL.row}+ ${CORNELL.summary}`
})

export const CornellRow = Node.create({
  name: CORNELL.row,
  content: `${CORNELL.cue} ${CORNELL.body}`,
  isolating: true,
  defining: true,
  addAttributes: () => ({
    mistakeId: {
      default: null,
      parseHTML: (el) => el.getAttribute('data-mistake-id'),
      renderHTML: (attrs) => (attrs.mistakeId ? { 'data-mistake-id': attrs.mistakeId } : {})
    }
  }),
  parseHTML: () => [{ tag: 'div[data-cornell="row"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', { ...HTMLAttributes, 'data-cornell': 'row', class: 'cornell-row' }, 0]
})

export const CornellCue = Node.create({
  name: CORNELL.cue,
  content: 'block+',
  isolating: true,
  parseHTML: () => [{ tag: 'div[data-cornell="cue"]' }],
  renderHTML: () => ['div', { 'data-cornell': 'cue', class: 'cornell-cue prose-cue' }, 0]
})

export const CornellBody = Node.create({
  name: CORNELL.body,
  content: 'block+',
  isolating: true,
  parseHTML: () => [{ tag: 'div[data-cornell="body"]' }],
  renderHTML: () => ['div', { 'data-cornell': 'body', class: 'cornell-body' }, 0]
})

export const CornellSummary = Node.create<{ label: string }>({
  name: CORNELL.summary,
  content: 'block+',
  isolating: true,
  addOptions: () => ({ label: 'Summary' }),
  parseHTML: () => [{ tag: 'section[data-cornell="summary"]' }],
  renderHTML({ HTMLAttributes }) {
    return [
      'section',
      { ...HTMLAttributes, 'data-cornell': 'summary', class: 'cornell-summary' },
      ['div', { class: 'cornell-label', contenteditable: 'false' }, this.options.label],
      ['div', { class: 'cornell-summary-content' }, 0]
    ]
  }
})

/** 找到光标所在的行，返回行的深度与位置 */
function findRow($pos: ResolvedPos): { depth: number; start: number; end: number; node: PMNode } | null {
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d)
    if (node.type.name === CORNELL.row) return { depth: d, start: $pos.before(d), end: $pos.after(d), node }
  }
  return null
}

function sectionOf($pos: ResolvedPos): 'cue' | 'body' | 'summary' | null {
  for (let d = $pos.depth; d > 0; d--) {
    const n = $pos.node(d).type.name
    if (n === CORNELL.cue) return 'cue'
    if (n === CORNELL.body) return 'body'
    if (n === CORNELL.summary) return 'summary'
  }
  return null
}

/** 行起始位置 → 线索 / 笔记内部第一个可输入位置 */
const cueStart = (rowStart: number): number => rowStart + 2
const bodyStart = (rowStart: number, row: PMNode): number => rowStart + 1 + row.child(0).nodeSize + 1

function selectNear(tr: Transaction, pos: number, bias: 1 | -1 = 1): Transaction {
  return tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size)), bias))
}

function rowsEnd(doc: PMNode): number {
  // 总结节点之前的位置 = 所有行之后
  return doc.content.size - doc.lastChild!.nodeSize
}

export const CornellKeymap = Extension.create({
  name: 'cornellKeymap',
  // 低于列表等扩展：列表的 Tab 缩进优先
  priority: 50,

  addCommands() {
    return {
      addCornellRow:
        (opts) =>
        ({ state, tr, dispatch }: CommandProps) => {
          const rowType = state.schema.nodes[CORNELL.row]
          const newRow = rowType.createAndFill()
          if (!newRow) return false
          const cur = findRow(state.selection.$from)
          const at = cur ? cur.end : rowsEnd(state.doc)
          if (dispatch) {
            tr.insert(at, newRow).setMeta('cornell:new-row', at)
            const target = opts?.focus === 'cue' ? cueStart(at) : bodyStart(at, newRow)
            selectNear(tr, target).scrollIntoView()
          }
          return true
        }
    }
  },

  addKeyboardShortcuts() {
    const move = (dir: 1 | -1) => (): boolean => {
      const { state, view } = this.editor
      const { $from } = state.selection
      const row = findRow($from)
      const sec = sectionOf($from)
      if (!row || !sec) return false
      const tr = state.tr
      if (dir === 1 && sec === 'cue') selectNear(tr, bodyStart(row.start, row.node))
      else if (dir === -1 && sec === 'body') selectNear(tr, cueStart(row.start))
      else if (dir === 1 && sec === 'body') {
        const next = state.doc.resolve(row.end).nodeAfter
        if (next?.type.name === CORNELL.row) selectNear(tr, cueStart(row.end))
        else return this.editor.commands.addCornellRow({ focus: 'cue' })
      } else if (dir === -1 && sec === 'cue') {
        const prev = state.doc.resolve(row.start).nodeBefore
        if (prev?.type.name !== CORNELL.row) return true
        selectNear(tr, row.start - 2, -1)
      }
      view.dispatch(tr.scrollIntoView())
      return true
    }

    return {
      Tab: move(1),
      'Shift-Tab': move(-1),
      Backspace: () => {
        const { state, view } = this.editor
        const { $from, empty } = state.selection
        if (!empty || $from.parentOffset !== 0) return false
        const row = findRow($from)
        if (!row || row.node.textContent.length > 0) return false
        let hasContent = false
        row.node.descendants((n) => {
          if (n.isAtom && n.type.name !== 'hardBreak') hasContent = true
        })
        if (hasContent) return false
        // 整行为空且不是唯一一行：删除该行，光标回到上一行笔记末尾
        let rows = 0
        state.doc.forEach((n) => n.type.name === CORNELL.row && rows++)
        if (rows <= 1) return false
        const onlyEmptyParagraphs = row.node.child(0).childCount === 1 && row.node.child(1).childCount === 1
        if (!onlyEmptyParagraphs) return false
        const tr = state.tr.delete(row.start, row.end)
        selectNear(tr, Math.max(0, row.start - 2), -1)
        view.dispatch(tr.scrollIntoView())
        return true
      }
    }
  }
})

/** “+ 新增一行”按钮：渲染在最后一行与总结之间 */
export const CornellAddRowWidget = Extension.create<{ label: string; hint: string }>({
  name: 'cornellAddRow',
  addOptions: () => ({ label: 'Add row', hint: '' }),
  addProseMirrorPlugins() {
    const editor = this.editor
    const { label, hint } = this.options
    return [
      new Plugin({
        key: new PluginKey('cornellAddRow'),
        props: {
          decorations: (state: EditorState) => {
            if (!editor.isEditable) return DecorationSet.empty
            const pos = rowsEnd(state.doc)
            const widget = Decoration.widget(
              pos,
              () => {
                const btn = document.createElement('button')
                btn.type = 'button'
                btn.className = 'cornell-add-row'
                btn.contentEditable = 'false'
                btn.innerHTML = `<span class="plus">+</span><span>${label}</span><kbd>${hint}</kbd>`
                btn.addEventListener('mousedown', (e) => e.preventDefault())
                btn.addEventListener('click', () => {
                  // 追加到最后一行之后，光标进入新行的笔记栏
                  const { state, view } = editor
                  const row = state.schema.nodes[CORNELL.row].createAndFill()
                  if (!row) return
                  const at = rowsEnd(state.doc)
                  const tr = state.tr.insert(at, row).setMeta('cornell:new-row', at)
                  view.dispatch(selectNear(tr, bodyStart(at, row)).scrollIntoView())
                  view.focus()
                })
                return btn
              },
              { side: -1, ignoreSelection: true, stopEvent: () => true, key: 'add-row' }
            )
            return DecorationSet.create(state.doc, [widget])
          }
        }
      })
    ]
  }
})

/** 段落级时间戳：悬停一行时显示该行最后修改时间 */
export const rowTimesKey = new PluginKey<Map<string, string>>('cornellRowTimes')

export const CornellRowTimes = Extension.create({
  name: 'cornellRowTimes',
  addProseMirrorPlugins() {
    return [
      new Plugin<Map<string, string>>({
        key: rowTimesKey,
        state: {
          init: () => new Map(),
          apply: (tr, value) => (tr.getMeta(rowTimesKey) as Map<string, string> | undefined) ?? value
        },
        props: {
          decorations(state) {
            const times = rowTimesKey.getState(state)
            if (!times?.size) return DecorationSet.empty
            const decos: Decoration[] = []
            state.doc.forEach((node, offset) => {
              const t = typeof node.attrs.id === 'string' ? times.get(node.attrs.id) : undefined
              if (t) decos.push(Decoration.node(offset, offset + node.nodeSize, { 'data-time': t }))
            })
            return DecorationSet.create(state.doc, decos)
          }
        }
      })
    ]
  }
})

/** 区块占位提示：线索 / 笔记 / 总结为空时显示（基于正在绘制的文档计算，避免位置越界） */
export const CornellPlaceholder = Extension.create<{ cue: string; body: string; summary: string }>({
  name: 'cornellPlaceholder',
  addOptions: () => ({ cue: '', body: '', summary: '' }),
  addProseMirrorPlugins() {
    const hints: Record<string, string> = {
      [CORNELL.cue]: this.options.cue,
      [CORNELL.body]: this.options.body,
      [CORNELL.summary]: this.options.summary
    }
    return [
      new Plugin({
        key: new PluginKey('cornellPlaceholder'),
        props: {
          decorations(state) {
            const decos: Decoration[] = []
            state.doc.descendants((node, pos) => {
              const hint = hints[node.type.name]
              if (hint === undefined) return true
              const only = node.childCount === 1 ? node.firstChild : null
              if (hint && only?.type.name === 'paragraph' && only.content.size === 0) {
                decos.push(Decoration.node(pos + 1, pos + 1 + only.nodeSize, { class: 'is-empty', 'data-placeholder': hint }))
              }
              return node.type.name === CORNELL.row
            })
            return DecorationSet.create(state.doc, decos)
          }
        }
      })
    ]
  }
})

/** ⌘/Ctrl+Enter 新增一行：高优先级，先于换行（HardBreak）处理 */
export const CornellShortcuts = Extension.create({
  name: 'cornellShortcuts',
  priority: 1000,
  addKeyboardShortcuts() {
    return { 'Mod-Enter': () => this.editor.commands.addCornellRow() }
  }
})
