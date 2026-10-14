import { describe, expect, it } from 'vitest'
import { parseUiJson, parseUiNode } from '../catalog'

// 这些样例来自真实 DeepSeek 评测里被判为非法的组件：意思对，格式差一点
describe('模型常见写法在校验前整理', () => {
  const ok = (value: unknown) => {
    const r = parseUiNode(value)
    if (!r.ok) throw new Error(r.error)
    return r.node
  }
  it('选项写成字符串', () => {
    const form = ok({
      type: 'form',
      fields: [{ key: 'priority', label: '更看重', kind: 'select', options: ['健康', '收入'], required: true }]
    })
    expect(form.type === 'form' && form.fields[0].options).toEqual([
      { label: '健康', value: '健康' },
      { label: '收入', value: '收入' }
    ])
    const choice = ok({ type: 'choice', question: '用途？', options: ['web', 'data'] })
    expect(choice.type === 'choice' && choice.options[1]).toEqual({ label: 'data', value: 'data' })
  })
  it('选项和字段可以多到 10 个', () => {
    ok({ type: 'choice', question: '?', options: Array.from({ length: 8 }, (_, i) => ({ label: `${i}`, value: `${i}` })) })
    ok({ type: 'form', fields: Array.from({ length: 7 }, (_, i) => ({ key: `k${i}`, label: `${i}`, kind: 'text' })) })
  })
  it('计算器变量允许大写和驼峰', () => {
    const calc = ok({
      type: 'calc',
      inputs: [
        { key: 'H', label: '总工时', kind: 'number', min: 1, max: 500, step: 1, value: 60 },
        { key: 'sciW', label: '每周', kind: 'range', min: 5, max: 60, step: 5, value: 25 }
      ],
      outputs: [{ label: '周数', expr: 'ceil(H/sciW)' }]
    })
    expect(calc.type === 'calc' && calc.inputs[1].kind).toBe('slider')
  })
  it('分栏比例写错时用默认', () => {
    const node = ok({
      type: 'columns',
      ratio: [1, 1],
      children: [
        { type: 'list', items: [{ text: 'a' }] },
        { type: 'list', items: [{ text: 'b' }] }
      ]
    })
    expect(node.type === 'columns' && node.ratio).toBeUndefined()
  })
  it('表格高亮的列写成序号', () => {
    const node = ok({
      type: 'table',
      columns: [
        { key: 'k', label: '项' },
        { key: 'a', label: 'A' }
      ],
      rows: [{ k: '交付', a: '10 天' }],
      highlight: [{ row: 0, col: 1 }]
    })
    expect(node.type === 'table' && node.highlight).toEqual([{ row: 0, col: 'a' }])
  })
  it('原文卡的 cite 写成编号字符串或资料片段 ID', () => {
    const a = ok({ type: 'excerpt', cite: '[2]' })
    expect(a.type === 'excerpt' && a.cite).toBe(2)
    const b = ok({ type: 'excerpt', cite: '01a139b2-421f-7759-924b-005332d11406' })
    expect(b.type === 'excerpt' && [b.cite, b.segmentId]).toEqual([undefined, '01a139b2-421f-7759-924b-005332d11406'])
  })
  it('引用编号写成字符串', () => {
    const node = ok({ type: 'list', items: [{ text: 'a', cite: ['1', 2] }], cite: '3' })
    expect(node.type === 'list' && [node.cite, node.items[0].cite]).toEqual([[3], [1, 2]])
  })
  it('已有决策附带空准则时只保留 decisionId', () => {
    const node = ok({ type: 'decision', decisionId: 'fae957ab', question: '?', options: [{ id: 'a', title: 'A' }], criteria: [], scores: [] })
    expect(node.type === 'decision' && [node.options, node.criteria]).toEqual([undefined, undefined])
  })
})

describe('围栏 JSON 的恢复', () => {
  it('完整对象后多写一截时取第一个完整对象', () => {
    const raw = '{"type":"diagram","code":"flowchart TD\\n  A[\\"引号}\\"] --> B"},"diagramTitle":"报销流程"}'
    expect(parseUiJson(raw)).toEqual({ type: 'diagram', code: 'flowchart TD\n  A["引号}"] --> B' })
  })
  it('真正不完整或后面跟着大段内容仍按非法处理', () => {
    expect(() => parseUiJson('{"type":"list","items":[')).toThrow()
    expect(() => parseUiJson('{"type":"list"}' + 'x'.repeat(500))).toThrow()
  })
})
