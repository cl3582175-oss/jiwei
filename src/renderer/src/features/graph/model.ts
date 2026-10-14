import type { GraphEdge, GraphNode, KnowledgeGraph } from '@shared/types'
import { arrowEnds, familyOf, type RelationFamily } from '@shared/graphRelations'
import { mix, type Tokens } from '../visuals/tokens'

/*
 * 知识图谱的视觉编码（v0.14.2）：
 * - 分类按创建顺序取 --viz-1…8，未分类为灰；资料是空心圆环
 * - 节点大小以连接数为主、字数为辅
 * - 连线按关系家族编码：相关（淡灰细线）、前置 / 属于（深墨色带箭头，像骨架）、推理（青碧）、张力（朱红）
 * - 枢纽：连接多个分类、连接数又多的笔记，外加一圈重点色光环
 */

export const FAMILIES: RelationFamily[] = ['assoc', 'structure', 'reasoning', 'tension']

export function categoryColors(g: KnowledgeGraph, c: Tokens): Map<string, string> {
  return new Map(g.categories.map((cat, i) => [cat.id, c.viz[i % c.viz.length]]))
}

export function degrees(edges: GraphEdge[]): Map<string, number> {
  const d = new Map<string, number>()
  for (const e of edges) {
    d.set(e.from, (d.get(e.from) ?? 0) + 1)
    d.set(e.to, (d.get(e.to) ?? 0) + 1)
  }
  return d
}

export function nodeSize(n: GraphNode, degree: number): number {
  if (n.type === 'source') return 5.5
  // 对数增长并封顶：几百条连接的笔记也不会变成一个大圆盘
  return Math.min(18, 4.5 + 3 * Math.log2(1 + degree) + Math.min(2.5, Math.log10(n.weight + 1)))
}

/** 枢纽：邻居跨 2 个以上其它分类、连接数不少于 4 的笔记，最多取 5 个 */
export function hubs(nodes: GraphNode[], edges: GraphEdge[]): Set<string> {
  const cat = new Map(nodes.map((n) => [n.key, n.categoryId]))
  const other = new Map<string, Set<string>>()
  const deg = degrees(edges)
  for (const e of edges)
    for (const [a, b] of [
      [e.from, e.to],
      [e.to, e.from]
    ]) {
      const cb = cat.get(b)
      if (cb && cb !== cat.get(a)) other.set(a, (other.get(a) ?? new Set()).add(cb))
    }
  return new Set(
    nodes
      .filter((n) => n.type === 'note' && (other.get(n.key)?.size ?? 0) >= 2 && (deg.get(n.key) ?? 0) >= 4)
      .sort((a, b) => (deg.get(b.key) ?? 0) * (other.get(b.key)?.size ?? 0) - (deg.get(a.key) ?? 0) * (other.get(a.key)?.size ?? 0))
      .slice(0, 5)
      .map((n) => n.key)
  )
}

export interface EdgeStyle {
  color: string
  size: number
  arrow: [string, string] | null
  family: RelationFamily | 'source'
}
export function edgeStyle(e: GraphEdge, c: Tokens): EdgeStyle {
  const suggested = e.status === 'suggested'
  const fade = (color: string): string => (suggested ? mix(color, c.surface, 0.45) : color)
  if (e.kind === 'source') return { color: mix(c.subtle, c.surface, 0.55), size: 0.9, arrow: null, family: 'source' }
  const family = familyOf(e.relation)
  const arrow = arrowEnds(e.relation, e.from, e.to)
  switch (family) {
    case 'structure':
      return { color: fade(mix(c.fg, c.surface, 0.85)), size: 2.6, arrow, family }
    case 'reasoning':
      return { color: fade(c.viz[2]), size: e.relation === 'derived_from' ? 2.2 : 1.8, arrow, family }
    case 'tension':
      return { color: fade(c.viz[3]), size: e.relation === 'contradicts' ? 2.6 : 1.9, arrow, family }
    default:
      return {
        color: fade(mix(c.subtle, c.surface, e.kind === 'related' ? 0.6 : 0.45)),
        size: 1,
        arrow: null,
        family
      }
  }
}

/** 凸包（Andrew 单调链），输入输出均为视口坐标 */
export function convexHull(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o: number[], a: number[], b: number[]): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: [number, number][] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: [number, number][] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

/** 只保留离焦点 depth 步以内的节点（连线不分方向） */
export function neighborhood(g: KnowledgeGraph, focus: string, depth: number): Set<string> {
  const adj = new Map<string, string[]>()
  for (const e of g.edges) {
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to])
    adj.set(e.to, [...(adj.get(e.to) ?? []), e.from])
  }
  const seen = new Set([focus])
  let frontier = [focus]
  for (let d = 0; d < depth; d++) {
    const next: string[] = []
    for (const k of frontier)
      for (const n of adj.get(k) ?? [])
        if (!seen.has(n)) {
          seen.add(n)
          next.push(n)
        }
    frontier = next
  }
  return seen
}

/** 以标题为主语的关系说明里，选中节点在关系中的位置 */
export const otherEnd = (e: GraphEdge, key: string): string => (e.from === key ? e.to : e.from)

/* ——— 学习路径（v0.14.3）：只看“前置”关系，按先修在左分层 ——— */

export interface PathModel {
  /** 每层的节点（已按父节点的平均位置排序，减少交叉） */
  layers: string[][]
  edges: [string, string][]
  /** 前置都已牢固、自己还没牢固：现在可以学 */
  frontier: Set<string>
  /** 没牢固、又挡住后面不少内容的：卡点（按挡住的数量排序） */
  blockers: { key: string; blocked: number }[]
  /** 前置关系里成环的笔记（多半是标反了） */
  cycle: Set<string>
}

export function learningPath(nodes: GraphNode[], edges: GraphEdge[]): PathModel {
  const solid = new Set(nodes.filter((n) => n.mastery === 'solid').map((n) => n.key))
  const pairs = edges
    .filter((e) => e.relation === 'prerequisite' && e.status === 'confirmed')
    .map((e) => [e.from, e.to] as [string, string])
  const keys = [...new Set(pairs.flat())]
  const out = new Map<string, string[]>(),
    into = new Map<string, string[]>()
  for (const [a, b] of pairs) {
    out.set(a, [...(out.get(a) ?? []), b])
    into.set(b, [...(into.get(b) ?? []), a])
  }
  // Kahn 拓扑排序；剩下的就是环
  const indeg = new Map(keys.map((k) => [k, into.get(k)?.length ?? 0]))
  const layer = new Map<string, number>()
  let queue = keys.filter((k) => !indeg.get(k))
  queue.forEach((k) => layer.set(k, 0))
  const order: string[] = []
  while (queue.length) {
    const next: string[] = []
    for (const k of queue) {
      order.push(k)
      for (const m of out.get(k) ?? []) {
        layer.set(m, Math.max(layer.get(m) ?? 0, (layer.get(k) ?? 0) + 1))
        indeg.set(m, indeg.get(m)! - 1)
        if (!indeg.get(m)) next.push(m)
      }
    }
    queue = next
  }
  const cycle = new Set(keys.filter((k) => !order.includes(k)))
  const depth = Math.max(0, ...layer.values())
  cycle.forEach((k) => layer.set(k, depth + 1))
  const layers: string[][] = []
  for (const k of [...order, ...cycle]) (layers[layer.get(k)!] ??= []).push(k)
  // 按父节点在上一层的平均位置排序
  for (let i = 1; i < layers.length; i++) {
    const pos = new Map((layers[i - 1] ?? []).map((k, j) => [k, j]))
    const score = (k: string): number => {
      const ps = (into.get(k) ?? []).map((p) => pos.get(p)).filter((p): p is number => p !== undefined)
      return ps.length ? ps.reduce((s, p) => s + p, 0) / ps.length : Infinity
    }
    layers[i] = (layers[i] ?? []).sort((a, b) => score(a) - score(b))
  }
  const frontier = new Set(keys.filter((k) => !solid.has(k) && !cycle.has(k) && (into.get(k) ?? []).every((p) => solid.has(p))))
  const descendants = (k: string): number => {
    const seen = new Set<string>()
    const walk = (x: string): void => {
      for (const m of out.get(x) ?? [])
        if (!seen.has(m)) {
          seen.add(m)
          walk(m)
        }
    }
    walk(k)
    return seen.size
  }
  const blockers = keys
    .filter((k) => !solid.has(k))
    .map((key) => ({ key, blocked: descendants(key) }))
    .filter((b) => b.blocked >= 2)
    .sort((a, b) => b.blocked - a.blocked)
    .slice(0, 5)
  return { layers: layers.filter(Boolean), edges: pairs, frontier, blockers, cycle }
}

/* ——— 知识缺口（v0.14.3）：孤立的笔记、几乎不与其它分类相连的分类、两个分类之间缺桥 ——— */

export interface Gaps {
  isolated: GraphNode[]
  lonely: { categoryId: string; notes: number; cross: number }[]
  bridges: { a: string; b: string; from: GraphNode; to: GraphNode }[]
}

export function knowledgeGaps(g: { nodes: GraphNode[]; edges: GraphEdge[]; categories: { id: string }[] }): Gaps {
  const notes = g.nodes.filter((n) => n.type === 'note')
  const byKey = new Map(notes.map((n) => [n.key, n]))
  const deg = degrees(g.edges)
  const isolated = notes
    .filter((n) => !deg.get(n.key))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 8)
  const size = new Map<string, GraphNode[]>()
  for (const n of notes) if (n.categoryId) size.set(n.categoryId, [...(size.get(n.categoryId) ?? []), n])
  const cross = new Map<string, number>()
  const between = new Set<string>()
  for (const e of g.edges) {
    const a = byKey.get(e.from)?.categoryId,
      b = byKey.get(e.to)?.categoryId
    if (!a || !b || a === b) continue
    cross.set(a, (cross.get(a) ?? 0) + 1)
    cross.set(b, (cross.get(b) ?? 0) + 1)
    between.add([a, b].sort().join('|'))
  }
  const big = g.categories.map((c) => c.id).filter((id) => (size.get(id)?.length ?? 0) >= 3)
  const lonely = big
    .map((categoryId) => ({ categoryId, notes: size.get(categoryId)!.length, cross: cross.get(categoryId) ?? 0 }))
    .filter((c) => c.cross <= 1)
  // 两个分类之间一条连线都没有：各取连接最多的一篇，拿来问“它们有什么联系”
  const top = (id: string): GraphNode => [...size.get(id)!].sort((x, y) => (deg.get(y.key) ?? 0) - (deg.get(x.key) ?? 0))[0]
  const bridges: Gaps['bridges'] = []
  for (let i = 0; i < big.length; i++)
    for (let j = i + 1; j < big.length; j++)
      if (!between.has([big[i], big[j]].sort().join('|'))) bridges.push({ a: big[i], b: big[j], from: top(big[i]), to: top(big[j]) })
  bridges.sort((x, y) => size.get(y.a)!.length * size.get(y.b)!.length - size.get(x.a)!.length * size.get(x.b)!.length)
  return { isolated, lonely, bridges: bridges.slice(0, 4) }
}
