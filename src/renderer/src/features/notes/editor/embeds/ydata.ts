import * as Y from 'yjs'
import { EMBEDS_FIELD } from '@shared/types'

// 富内容块数据与 Yjs 之间的转换：对象 → Y.Map，数组 → Y.Array，递归。
// 使用嵌套 Y 结构，协作时每个字段 / 节点都能独立合并。

export function toY(value: unknown): unknown {
  if (Array.isArray(value)) {
    const arr = new Y.Array<unknown>()
    arr.push(value.map(toY))
    return arr
  }
  if (value && typeof value === 'object') {
    const map = new Y.Map<unknown>()
    for (const [k, v] of Object.entries(value)) if (v !== undefined) map.set(k, toY(v))
    return map
  }
  return value
}

export function embedsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(EMBEDS_FIELD)
}

/** 写入一个富内容块的数据：{ kind, data } */
export function writeEmbed(doc: Y.Doc, id: string, kind: string, data: unknown): void {
  const entry = new Y.Map<unknown>()
  entry.set('kind', kind)
  entry.set('data', toY(data))
  embedsMap(doc).set(id, entry)
}
