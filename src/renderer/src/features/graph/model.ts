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
