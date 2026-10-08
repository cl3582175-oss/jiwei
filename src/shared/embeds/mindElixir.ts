import type { MindmapData, MindmapNode, MindmapTree } from './mindmap'

// 积微导图数据 ⇄ mind-elixir 数据（编辑器使用）。原文锚点与备注存放在节点 metadata 中，往返不丢失。
// 只描述用到的字段，不依赖 mind-elixir 的类型（便于单元测试）。

export interface ElixirNode {
  id: string
  topic: string
  children?: ElixirNode[]
  metadata?: Meta
}
export interface ElixirData {
  nodeData: ElixirNode
}

type Meta = { anchor?: MindmapNode['anchor']; note?: string }

export function toElixir(tree: MindmapTree): ElixirData {
  const conv = (t: MindmapTree): ElixirNode => ({
    id: t.id,
    topic: t.text,
    ...(t.anchor || t.note ? { metadata: { anchor: t.anchor, note: t.note } } : {}),
    children: t.children.map(conv)
  })
  return { nodeData: conv(tree) }
}

export function fromElixir(d: ElixirData): MindmapData {
  const nodes: MindmapData['nodes'] = {}
  const walk = (n: ElixirNode, parent: string | null, order: number): void => {
    const m = n.metadata
    nodes[n.id] = {
      text: String(n.topic ?? '').slice(0, 500),
      parent,
      order,
      ...(m?.anchor ? { anchor: m.anchor } : {}),
      ...(m?.note ? { note: m.note } : {})
    }
    n.children?.forEach((c, i) => walk(c, n.id, i))
  }
  walk(d.nodeData, null, 0)
  return { root: d.nodeData.id, nodes }
}
