import { z } from 'zod'

// 思维导图数据模型（与具体显示组件无关）：
//   扁平节点表 + 父指针 + 顺序。扁平结构在 Yjs 中每个节点都可以独立合并（协作友好），
//   也便于 AI 生成与校验。每个节点可带原文锚点，点击即可回到资料原文。

export const MindmapAnchorSchema = z.object({
  type: z.enum(['segment', 'block', 'source']),
  id: z.string(),
  /** 可选的细粒度定位（W3C 选择器值，如 page=12、t=95,120） */
  selector: z.string().optional()
})

export const MindmapNodeSchema = z.object({
  text: z.string().max(500),
  parent: z.string().nullable(),
  order: z.number(),
  anchor: MindmapAnchorSchema.optional(),
  note: z.string().max(2000).optional()
})

export const MindmapDataSchema = z.object({
  root: z.string(),
  nodes: z.record(z.string(), MindmapNodeSchema)
})

export type MindmapNode = z.infer<typeof MindmapNodeSchema>
export type MindmapData = z.infer<typeof MindmapDataSchema>

export interface MindmapTree {
  id: string
  text: string
  anchor?: MindmapNode['anchor']
  note?: string
  children: MindmapTree[]
}

/** 便于 AI 输出的嵌套格式 → 扁平数据 */
export interface NestedNode {
  text: string
  anchor?: MindmapNode['anchor']
  note?: string
  children?: NestedNode[]
}

export function fromNested(root: NestedNode, makeId: () => string): MindmapData {
  const nodes: MindmapData['nodes'] = {}
  const walk = (n: NestedNode, parent: string | null, order: number): string => {
    const id = makeId()
    nodes[id] = { text: n.text, parent, order, ...(n.anchor ? { anchor: n.anchor } : {}), ...(n.note ? { note: n.note } : {}) }
    n.children?.forEach((c, i) => walk(c, id, i))
    return id
  }
  return { root: walk(root, null, 0), nodes }
}

export function toTree(data: MindmapData): MindmapTree | null {
  const children = new Map<string, string[]>()
  for (const [id, n] of Object.entries(data.nodes)) {
    if (n.parent) children.set(n.parent, [...(children.get(n.parent) ?? []), id])
  }
  const seen = new Set<string>()
  const build = (id: string): MindmapTree | null => {
    const n = data.nodes[id]
    if (!n || seen.has(id)) return null
    seen.add(id)
    const kids = (children.get(id) ?? [])
      .sort((a, b) => data.nodes[a].order - data.nodes[b].order)
      .map(build)
      .filter((x): x is MindmapTree => !!x)
    return { id, text: n.text, anchor: n.anchor, note: n.note, children: kids }
  }
  return build(data.root)
}

/** 缩进大纲：用于检索、RAG、字数统计 */
export function toText(data: MindmapData): string {
  const tree = toTree(data)
  if (!tree) return ''
  const lines: string[] = []
  const walk = (t: MindmapTree, depth: number): void => {
    lines.push('  '.repeat(depth) + t.text + (t.note ? `：${t.note}` : ''))
    t.children.forEach((c) => walk(c, depth + 1))
  }
  walk(tree, 0)
  return lines.join('\n')
}

/** Markdown 标题 / 列表：用于 Markmap 渲染与导出 */
export function toMarkdown(data: MindmapData): string {
  const tree = toTree(data)
  if (!tree) return ''
  const lines = [`# ${tree.text}`]
  const walk = (t: MindmapTree, depth: number): void => {
    lines.push(depth <= 2 ? `${'#'.repeat(depth + 1)} ${t.text}` : `${'  '.repeat(depth - 3)}- ${t.text}`)
    t.children.forEach((c) => walk(c, depth + 1))
  }
  tree.children.forEach((c) => walk(c, 1))
  return lines.join('\n')
}

/**
 * 思维导图 → 康奈尔行：每个一级分支成为一行，分支名进线索栏，其子树进笔记栏（列表）。
 * 返回 ProseMirror JSON（不含 ID，由编辑器分配）。
 */
export function toCornellRows(data: MindmapData): { cue: unknown[]; body: unknown[] }[] {
  const tree = toTree(data)
  if (!tree) return []
  const para = (text: string): unknown => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })
  const list = (items: MindmapTree[]): unknown => ({
    type: 'bulletList',
    content: items.map((c) => ({ type: 'listItem', content: [para(c.text), ...(c.children.length ? [list(c.children)] : [])] }))
  })
  const branches = tree.children.length ? tree.children : [tree]
  return branches.map((b) => ({
    cue: [para(b.text)],
    body: b.children.length ? [list(b.children)] : [para(b.note ?? '')]
  }))
}
