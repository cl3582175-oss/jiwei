import { Extension } from '@tiptap/core'
import { isChangeOrigin } from '@tiptap/extension-collaboration'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'
import type { Origin } from '@shared/types'
import { ID_TYPES } from './extensions'

// 内容来源：带 ID 的块都有 origin 属性（JSON 字符串）。
//   空 = 用户亲手写；{ by: 'ai', … } = AI 生成；用户编辑过的 AI 块自动标记 reviewed。
// 应用 AI 提案的事务带 PROPOSAL_META，不会触发“已审阅”标记。

export const PROPOSAL_META = 'jiwei:proposal'
export const ORIGIN_TYPES = ID_TYPES

export function parseOrigin(v: unknown): Origin | null {
  if (typeof v !== 'string' || !v) return null
  try {
    return JSON.parse(v) as Origin
  } catch {
    return null
  }
}

export const OriginAttribute = Extension.create({
  name: 'origin',
  addGlobalAttributes() {
    return [
      {
        types: ORIGIN_TYPES,
        attributes: {
          origin: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => el.getAttribute('data-origin-json'),
            renderHTML: (attrs) => {
              const o = parseOrigin(attrs.origin)
              if (!o) return {}
              return { 'data-origin': o.reviewed ? 'ai-reviewed' : 'ai', 'data-origin-json': attrs.origin as string }
            }
          }
        }
      }
    ]
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('originReview'),
        appendTransaction: (trs: readonly Transaction[], _old, state) => {
          // 只处理用户在本机的编辑
          const userTrs = trs.filter(
            (tr) =>
              tr.docChanged &&
              !tr.getMeta(PROPOSAL_META) &&
              !isChangeOrigin(tr) &&
              // 系统性事务（ID 分配、时间戳刷新等）不算用户编辑
              !tr.getMeta('__uniqueIDTransaction') &&
              tr.getMeta('addToHistory') !== false
          )
          if (userTrs.length === 0) return null
          // 收集本次修改在新文档中的范围
          const ranges: [number, number][] = []
          trs.forEach((tr, i) => {
            if (!userTrs.includes(tr)) return
            tr.mapping.maps.forEach((map, j) => {
              map.forEach((_oS, _oE, nS, nE) => {
                let from = nS
                let to = nE
                // 映射到最终文档
                for (let k = j + 1; k < tr.mapping.maps.length; k++) {
                  from = tr.mapping.maps[k].map(from, -1)
                  to = tr.mapping.maps[k].map(to, 1)
                }
                for (let k = i + 1; k < trs.length; k++) {
                  from = trs[k].mapping.map(from, -1)
                  to = trs[k].mapping.map(to, 1)
                }
                ranges.push([from, to])
              })
            })
          })
          const tr = state.tr
          const touched = new Set<number>()
          for (const [from, to] of ranges) {
            state.doc.nodesBetween(Math.max(0, from), Math.min(state.doc.content.size, Math.max(from, to)), (node, pos) => {
              const o = parseOrigin(node.attrs.origin)
              if (o && o.by === 'ai' && !o.reviewed && !touched.has(pos)) {
                touched.add(pos)
                tr.setNodeAttribute(pos, 'origin', JSON.stringify({ ...o, reviewed: true }))
              }
              return true
            })
          }
          return touched.size ? tr.setMeta('addToHistory', false) : null
        }
      })
    ]
  }
})
