import { describe, expect, it } from 'vitest'
import { checkChart, type ChartData } from '@shared/embeds/visuals'
import { decorateDiagram, mermaidThemeVariables } from '../mermaidTheme'
import { mix, type Tokens } from '../tokens'

const viz = ['#2f6fb3', '#d9682b', '#1f9a8a', '#c94540', '#7a5cc2', '#b07d0a', '#d0527a', '#3d7f2a']
const c = {
  accent: '#3d8a74',
  accentFg: '#ffffff',
  fg: '#222222',
  muted: '#666666',
  subtle: '#999999',
  border: '#dddddd',
  borderStrong: '#cccccc',
  surface: '#ffffff',
  sunken: '#f4f4f2',
  danger: '#c0473a',
  dark: '',
  p1: '',
  p2: '',
  p3: '',
  p4: '',
  p5: '',
  emph: viz[1],
  rest: '#cccccc',
  viz,
  vizSoft: viz.map((v) => mix(v, '#ffffff', 0.14))
} satisfies Tokens

type V = { id: string; type?: string; classes: string[] }
const fake = (vertices: V[], edges: [string, string][], subgraphs: { id: string; nodes: string[]; classes: string[] }[] = []) => ({
  mermaidAPI: {
    getDiagramFromText: async () => ({
      type: 'flowchart-v2',
      db: {
        getVertices: () => new Map(vertices.map((v) => [v.id, v])),
        getEdges: () => edges.map(([start, end]) => ({ start, end })),
        getSubGraphs: () => subgraphs
      }
    })
  }
})

describe('示意图按角色上色', () => {
  it('起点、判断、终点各有颜色，模型标了 key 的节点不被覆盖', async () => {
    const m = fake(
      [
        { id: 'A', classes: [] },
        { id: 'B', type: 'diamond', classes: [] },
        { id: 'C', classes: ['key'] },
        { id: 'D', classes: [] },
        { id: 'E', classes: [] }
      ],
      [
        ['A', 'B'],
        ['B', 'C'],
        ['B', 'D'],
        ['C', 'D'],
        ['D', 'E']
      ]
    )
    const out = await decorateDiagram('flowchart LR\n  A-->B', m, c)
    expect(out).toContain('class A jwstart')
    expect(out).toContain('class B jwdecide')
    expect(out).toContain('class E jwend')
    expect(out).not.toMatch(/class [^\n]*\bC\b/)
    expect(out).not.toMatch(/class [^\n]*\bD\b/)
    expect(out).toContain(`classDef key fill:${c.emph}`)
  })
  it('子图里的节点按组上色，子图有淡底色', async () => {
    const m = fake(
      [
        { id: 'A', classes: [] },
        { id: 'B', classes: [] },
        { id: 'C', classes: [] }
      ],
      [
        ['A', 'B'],
        ['B', 'C']
      ],
      [
        { id: 'in', nodes: ['A', 'B'], classes: [] },
        { id: 'out', nodes: ['C'], classes: [] }
      ]
    )
    const out = await decorateDiagram('graph TB\n  A-->B', m, c)
    expect(out).toContain('class A,B c1')
    expect(out).toContain('class C c2')
    expect(out).toMatch(/style in fill:#[0-9a-f]{6},stroke:/)
  })
  it('不是流程图或解析失败时原样返回', async () => {
    const broken = { mermaidAPI: { getDiagramFromText: async () => Promise.reject(new Error('x')) } }
    expect(await decorateDiagram('sequenceDiagram\n A->>B: hi', broken, c)).toBe('sequenceDiagram\n A->>B: hi')
    expect(await decorateDiagram('graph LR\n A-->', broken, c)).toBe('graph LR\n A-->')
  })
  it('不安全的节点 ID 不写进配色语句', async () => {
    const m = fake(
      [
        { id: 'A;click', classes: [] },
        { id: 'B', classes: [] },
        { id: 'C', classes: [] }
      ],
      [
        ['A;click', 'B'],
        ['B', 'C']
      ]
    )
    const out = await decorateDiagram('graph LR\n  A-->B', m, c)
    expect(out).not.toContain('A;click')
    expect(out).toContain('class C jwend')
  })
  it('主题变量都是实色，饼图和思维导图用分类色', () => {
    const t = mermaidThemeVariables(c)
    expect(t.pie1).toBe(viz[0])
    expect(t.cScalePeer2).toBe(viz[2])
    for (const [k, v] of Object.entries(t)) if (typeof v === 'string' && /Color|Bkg|Fill|cScale|pie\d/.test(k)) expect(v).toMatch(/^#[0-9a-f]{6}$/i)
  })
})

describe('图表 highlight', () => {
  const chart: ChartData = { type: 'bar', categories: ['一', '二'], series: [{ name: '步数', data: [1, 2] }] }
  it('可以点名类目或系列', () => {
    expect(checkChart({ ...chart, highlight: ['二'] })).toBeNull()
    expect(checkChart({ ...chart, highlight: ['步数'] })).toBeNull()
  })
  it('点名不存在的名字会报错，让模型修正', () => {
    expect(checkChart({ ...chart, highlight: ['三'] })).toContain('三')
  })
})
