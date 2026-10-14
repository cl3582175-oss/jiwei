import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode } from '@shared/types'
import { arrowEnds, relationSentence, RELATIONS, RELATION_META } from '@shared/graphRelations'
import { convexHull, hubs, knowledgeGaps, learningPath, neighborhood } from '../model'

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

describe('学习路径与知识缺口', () => {
  const solid = (n: GraphNode): GraphNode => ({ ...n, mastery: 'solid' })
  it('先修在左；前置都已牢固的标为可以学了，挡住多篇的标为卡点，成环单独标出', () => {
    const nodes = [solid(node('a', 'x')), node('b', 'x'), node('c', 'x'), node('d', 'x'), node('e', 'y'), node('f', 'y')]
    const edges = [
      edge('a', 'b', 'prerequisite'),
      edge('b', 'c', 'prerequisite'),
      edge('b', 'd', 'prerequisite'),
      edge('e', 'f', 'prerequisite'),
      edge('f', 'e', 'prerequisite')
    ]
    const p = learningPath(nodes, edges)
    expect(p.layers[0]).toEqual(['a'])
    expect(p.layers[1]).toEqual(['b'])
    expect([...p.frontier]).toEqual(['b'])
    expect(p.blockers[0]).toEqual({ key: 'b', blocked: 2 })
    expect([...p.cycle].sort()).toEqual(['e', 'f'])
  })
  it('只看已确认的前置关系', () => {
    const p = learningPath([node('a', 'x'), node('b', 'x')], [{ ...edge('a', 'b', 'prerequisite'), status: 'suggested' }])
    expect(p.layers).toHaveLength(0)
  })
  it('缺口：孤立笔记、少与外界相连的分类、两个分类之间缺桥', () => {
    const nodes = [
      ...['x1', 'x2', 'x3'].map((k) => node(k, 'x')),
      ...['y1', 'y2', 'y3'].map((k) => node(k, 'y')),
      ...['z1', 'z2', 'z3'].map((k) => node(k, 'z')),
      node('lone', null)
    ]
    const edges = [edge('x1', 'x2'), edge('y1', 'y2'), edge('z1', 'z2'), edge('x3', 'y3')]
    const g = knowledgeGaps({ nodes, edges, categories: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] })
    expect(g.isolated.map((n) => n.key).sort()).toEqual(['lone', 'z3'])
    expect(g.lonely.map((l) => l.categoryId).sort()).toEqual(['x', 'y', 'z'])
    expect(g.bridges.map((b) => [b.a, b.b].join()).sort()).toEqual(['x,z', 'y,z'])
  })
})
