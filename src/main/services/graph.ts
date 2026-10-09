import { and, eq, inArray, isNull } from 'drizzle-orm'
import { getDb } from '../db'
import { categories, notes, sourceSegments, sources } from '../db/schema'
import type { KnowledgeGraph, GraphNode } from '@shared/types'
import { allEdges } from './connections'
import { masteryMap } from './progress'

// 知识结构图（v0.5.1）：笔记与资料为节点，正文链接、手动关联、资料出处为连线。
// 笔记按顶级分类着色，或按掌握度着色（与掌握度地图同一套规则）。资料只在被引用时出现。

export function knowledgeGraph(): KnowledgeGraph {
  const db = getDb()
  const cats = db
    .select({ id: categories.id, name: categories.name, color: categories.color, parentId: categories.parentId })
    .from(categories)
    .where(and(eq(categories.kind, 'note'), isNull(categories.deletedAt)))
    .all()
  const parent = new Map(cats.map((c) => [c.id, c.parentId]))
  const top = (id: string | null): string | null => {
    let cur = id
    for (let i = 0; cur && parent.get(cur) && i < 20; i++) cur = parent.get(cur) ?? null
    return cur && parent.has(cur) ? cur : null
  }
  const mastery = new Map(masteryMap().notes.map((n) => [n.id, n.status]))
  const noteRows = db
    .select({ id: notes.id, title: notes.title, categoryId: notes.categoryId, wordCount: notes.wordCount })
    .from(notes)
    .where(and(isNull(notes.deletedAt), eq(notes.kind, 'cornell')))
    .all()
  const nodes: GraphNode[] = noteRows.map((n) => ({
    key: `note:${n.id}`,
    type: 'note',
    id: n.id,
    title: n.title,
    categoryId: top(n.categoryId),
    weight: n.wordCount,
    mastery: mastery.get(n.id) ?? (n.wordCount ? 'blank' : null)
  }))
  const have = new Set(nodes.map((n) => n.key))
  const edges = allEdges().filter((e) => have.has(e.from))
  // 被引用的资料
  const srcIds = [...new Set(edges.filter((e) => e.to.startsWith('source:')).map((e) => e.to.slice(7)))]
  if (srcIds.length) {
    const rows = db
      .select({ id: sources.id, title: sources.title })
      .from(sources)
      .where(and(inArray(sources.id, srcIds), isNull(sources.deletedAt)))
      .all()
    const counts = new Map<string, number>()
    for (const s of db.select({ sourceId: sourceSegments.sourceId }).from(sourceSegments).where(inArray(sourceSegments.sourceId, srcIds)).all())
      counts.set(s.sourceId, (counts.get(s.sourceId) ?? 0) + 1)
    for (const s of rows) {
      nodes.push({ key: `source:${s.id}`, type: 'source', id: s.id, title: s.title, categoryId: null, weight: counts.get(s.id) ?? 1, mastery: null })
      have.add(`source:${s.id}`)
    }
  }
  // 去重（同一对节点多条链接只画一条，手动关联优先显示）
  const uniq = new Map<string, KnowledgeGraph['edges'][number]>()
  for (const e of edges) {
    if (!have.has(e.to) || e.from === e.to) continue
    const k = [e.from, e.to].sort().join('|')
    const prev = uniq.get(k)
    if (!prev || (e.kind === 'related' && prev.kind !== 'related')) uniq.set(k, e)
  }
  const used = new Set(nodes.filter((n) => n.categoryId).map((n) => n.categoryId!))
  return {
    nodes,
    edges: [...uniq.values()],
    categories: cats.filter((c) => used.has(c.id)).map((c) => ({ id: c.id, name: c.name, color: c.color }))
  }
}
