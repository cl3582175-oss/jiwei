import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { diffArrays } from 'diff'

// AI 修改的行内差异：提案中的“替换段落 / 删除段落”直接显示在原文处——
// 原段落变淡，下方出现差异卡片（红色删除线 = 删去，绿色 = 新增），逐条接受或拒绝。
// 中文按词切分（Intl.Segmenter），差异以词为单位，读起来自然。

export interface DiffItem {
  proposalId: string
  opIndex: number
  blockId: string
  kind: 'replace' | 'delete'
  title: string
  /** 新内容的纯文本（段落之间以换行分隔） */
  newText?: string
}

export const DIFF_DECISION = 'jiwei:proposal-decision'
export interface DiffDecision {
  proposalId: string
  opIndex: number
  decision: 'accepted' | 'rejected'
}

export const diffKey = new PluginKey<DiffItem[]>('proposalDiff')

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null
const tokens = (s: string): string[] => (segmenter ? [...segmenter.segment(s)].map((x) => x.segment) : s.split(/(\s+)/))

/** 词级差异 */
export function wordDiff(a: string, b: string): { value: string; added?: boolean; removed?: boolean }[] {
  return diffArrays(tokens(a), tokens(b)).map((p) => ({ value: p.value.join(''), added: p.added, removed: p.removed }))
}

function findBlock(doc: PMNode, id: string): { node: PMNode; pos: number } | null {
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

const blockText = (n: PMNode): string => n.textBetween(0, n.content.size, '\n', ' ')

function card(item: DiffItem, oldText: string, labels: Labels): HTMLElement {
  const el = document.createElement('div')
  el.className = 'diff-card'
  el.contentEditable = 'false'
  el.setAttribute('role', 'group')
  el.setAttribute('aria-label', `${labels.suggestion}：${item.title}`)
  const head = document.createElement('div')
  head.className = 'diff-head'
  head.textContent = `✦ ${labels.suggestion} · ${item.title}`
  el.appendChild(head)
  const body = document.createElement('div')
  body.className = 'diff-body'
  if (item.kind === 'delete') {
    // 原段落已划掉，卡片只说明操作
    body.className = 'diff-body diff-note'
    body.textContent = labels.deleteHint
  } else {
    for (const part of wordDiff(oldText, item.newText ?? '')) {
      const span = document.createElement(part.added ? 'ins' : part.removed ? 'del' : 'span')
      span.textContent = part.value
      body.appendChild(span)
    }
  }
  el.appendChild(body)
  const actions = document.createElement('div')
  actions.className = 'diff-actions'
  const btn = (label: string, decision: DiffDecision['decision'], cls: string): void => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = cls
    b.textContent = label
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', () =>
      window.dispatchEvent(
        new CustomEvent<DiffDecision>(DIFF_DECISION, { detail: { proposalId: item.proposalId, opIndex: item.opIndex, decision } })
      )
    )
    actions.appendChild(b)
  }
  btn(labels.accept, 'accepted', 'diff-accept')
  btn(labels.reject, 'rejected', 'diff-reject')
  el.appendChild(actions)
  return el
}

interface Labels {
  suggestion: string
  accept: string
  reject: string
  deleteHint: string
}

export const ProposalDiff = Extension.create<{ labels: Labels }>({
  name: 'proposalDiff',
  addOptions: () => ({
    labels: { suggestion: 'AI suggestion', accept: 'Accept', reject: 'Reject', deleteHint: 'Delete the paragraph above' }
  }),
  addProseMirrorPlugins() {
    const labels = this.options.labels
    return [
      new Plugin<DiffItem[]>({
        key: diffKey,
        state: {
          init: () => [],
          apply: (tr, prev) => (tr.getMeta(diffKey) as DiffItem[] | undefined) ?? prev
        },
        props: {
          decorations(state) {
            const items = diffKey.getState(state) ?? []
            if (!items.length) return null
            const decos: Decoration[] = []
            for (const item of items) {
              const t = findBlock(state.doc, item.blockId)
              if (!t) continue
              const end = t.pos + t.node.nodeSize
              decos.push(Decoration.node(t.pos, end, { class: item.kind === 'delete' ? 'diff-old is-delete' : 'diff-old' }))
              const oldText = blockText(t.node)
              decos.push(
                Decoration.widget(end, () => card(item, oldText, labels), {
                  side: 1,
                  key: `${item.proposalId}:${item.opIndex}:${item.newText?.length ?? 0}`
                })
              )
            }
            return DecorationSet.create(state.doc, decos)
          }
        }
      })
    ]
  }
})
