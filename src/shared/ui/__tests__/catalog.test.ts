import { describe, expect, it } from 'vitest'
import { parseUiNode, partialUiNode, uiToText, uiFallbackMarkdown, toChartData, UiEmbedSchema } from '../catalog'
import { parsePartialJson } from '../partialJson'
import { embedText } from '../../embeds'
import { samples, invalid } from './fixtures'

describe('组件目录与文字退回', () => {
  for (const [type, sample] of Object.entries(samples)) {
    it(`${type} 接受合法数据，拒绝超限字段及错误结构`, () => {
      expect(parseUiNode(sample).ok).toBe(true)
      expect(parseUiNode({ ...sample, title: '超'.repeat(121) }).ok).toBe(false)
      expect(parseUiNode(invalid[type as keyof typeof invalid]).ok).toBe(false)
    })
    it(`${type} 始终提供可读文字与退回内容`, () => {
      const r = parseUiNode({ ...sample, title: '标题' })
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(uiToText(r.node)).toContain('标题')
      expect(uiFallbackMarkdown(r.node, '')).toContain('标题')
    })
  }
  it('表格截断至 50 行而不拒绝整块数据', () => {
    const r = parseUiNode({ ...samples.table, rows: Array.from({ length: 51 }, (_, n) => ({ n })) })
    expect(r.ok).toBe(true)
    if (r.ok && r.node.type === 'table') {
      expect(r.node.rows).toHaveLength(50)
      expect(r.node.rows[49]).toEqual({ n: 49 })
    }
  })
  it('图表转换还原现有数据类型，错误图表退回数据表', () => {
    const r = parseUiNode(samples.chart)
    if (!r.ok || r.node.type !== 'chart') throw new Error('chart')
    expect(toChartData(r.node)).toEqual({ type: 'bar', categories: ['一', '二'], series: [{ name: '次数', data: [2, 3] }] })
    expect(uiFallbackMarkdown(invalid.chart, '')).toContain('| 一 | 2 |')
    expect(uiFallbackMarkdown(invalid.chart, '')).toContain('| 二 |  |')
  })
  it('表格文本独立可读并中和单元格里的 Markdown 围栏和 HTML', () => {
    const r = parseUiNode({ ...samples.table, rows: [{ n: '| <script> ```jiwei-ui' }] })
    if (!r.ok) throw new Error(r.error)
    expect(uiToText(r.node)).toContain('\\| &lt;script&gt;')
    expect(uiToText(r.node)).not.toContain('```jiwei-ui')
  })
  it('拒绝超字节、超深度、过多节点与循环对象', () => {
    expect(parseUiNode({ ...samples.list, unknown: '中'.repeat(25_000) }).ok).toBe(false)
    let tree: unknown = samples.list
    for (let i = 0; i < 4; i++) tree = { type: 'details', summary: '层', children: [tree] }
    expect(parseUiNode(tree).ok).toBe(false)
    const branch = { type: 'details', summary: '层', children: [samples.list, samples.list, samples.list] }
    expect(
      parseUiNode({ type: 'tabs', tabs: Array.from({ length: 5 }, () => ({ label: '页', children: [branch, branch, branch] })) }).ok
    ).toBe(false)
    const circular: Record<string, unknown> = { ...samples.list }
    circular.self = circular
    expect(() => parseUiNode(circular)).not.toThrow()
    expect(parseUiNode(circular).ok).toBe(false)
  })
  it('只显示完整的表格行和清单条目', () => {
    const table = partialUiNode(parsePartialJson('{"type":"table","columns":[{"key":"n","label":"人数"}],"rows":[{"n":1},{"n":').value)
    expect(table.node.rows).toEqual([{ n: 1 }])
    const list = partialUiNode(parsePartialJson('{"type":"list","items":[{"text":"完整"},{"text":"半').value)
    expect(list.node.items).toEqual([{ text: '完整' }])
  })
  it('ui 富内容块的文字进入现有索引注册表', () => {
    const data = { node: samples.list, savedAt: 1 }
    expect(UiEmbedSchema.safeParse(data).success).toBe(true)
    expect(embedText('ui', data)).toBe('- [ ] 检查证据')
    expect(UiEmbedSchema.safeParse({ node: invalid.calc, savedAt: 1 }).success).toBe(false)
  })
})
