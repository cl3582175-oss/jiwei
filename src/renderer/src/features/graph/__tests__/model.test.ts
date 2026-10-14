import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode } from '@shared/types'
import { arrowEnds, relationSentence, RELATIONS, RELATION_META } from '@shared/graphRelations'
import { convexHull, hubs, neighborhood } from '../model'

const node = (key: string, categoryId: string | null): GraphNode => ({
  key,
  type: 'note',
  id: key,
  title: key,
  categoryId,
  weight: 100,
  mastery: null,
  excerpt: '',
  status: 'active',
  createdAt: 0
})
const edge = (from: string, to: string, relation: GraphEdge['relation'] = 'related'): GraphEdge => ({
  from,
  to,
  kind: 'related',
  relation,
  status: 'confirmed'
})

describe('关系词表', () => {
  it('每种关系都有中英文名和句子', () => {
    for (const r of RELATIONS) {
      const m = RELATION_META[r]
      expect(m.zh && m.en && m.zhSentence.includes('{a}') && m.zhSentence.includes('{b}')).toBeTruthy()
    }
  })
  it('句子以 A 为主语，箭头按关系的读法', () => {
    expect(relationSentence('prerequisite', '边际效用', '需求曲线', true)).toBe('学 《需求曲线》 之前要先懂 《边际效用》')
    expect(relationSentence('derived_from', '市场均衡', '需求曲线', true)).toBe('由 《需求曲线》 推出 《市场均衡》')
    expect(relationSentence('contrasts', 'p', 'q', false)).toBe('“p” contrasts with “q”')
    expect(arrowEnds('prerequisite', 'a', 'b')).toEqual(['a', 'b'])
    expect(arrowEnds('derived_from', 'a', 'b')).toEqual(['b', 'a'])
    expect(arrowEnds('contrasts', 'a', 'b')).toBeNull()
  })
})

describe('图的几何与结构', () => {
  it('凸包去掉内部点', () => {
    const hull = convexHull([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [5, 5]
    ])
    expect(hull).toHaveLength(4)
    expect(hull).not.toContainEqual([5, 5])
  })
  it('局部图只取若干步以内的节点', () => {
    const g = {
      nodes: ['a', 'b', 'c', 'd'].map((k) => node(k, null)),
      edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')],
      categories: []
    }
    expect([...neighborhood(g, 'a', 1)].sort()).toEqual(['a', 'b'])
    expect([...neighborhood(g, 'a', 2)].sort()).toEqual(['a', 'b', 'c'])
  })
  it('枢纽：连接多个其它分类且连接数多的笔记', () => {
    const nodes = [node('hub', 'x'), node('a', 'y'), node('b', 'z'), node('c', 'x'), node('d', 'y'), node('lone', 'x')]
    const edges = [edge('hub', 'a'), edge('hub', 'b'), edge('hub', 'c'), edge('hub', 'd'), edge('lone', 'c')]
    expect([...hubs(nodes, edges)]).toEqual(['hub'])
  })
})
