import { describe, expect, it } from 'vitest'
import { checkGraph, compileExpression, GraphDataSchema, graphText, parseExpression } from '../embeds/graph'

const f = (src: string, env: Record<string, number> = {}, vars = ['x']): number => compileExpression(src, vars)(env)

describe('函数表达式', () => {
  it('四则、乘方、优先级与结合性', () => {
    expect(f('1 + 2 * 3')).toBe(7)
    expect(f('(1 + 2) * 3')).toBe(9)
    expect(f('2 ^ 3 ^ 2')).toBe(512)
    expect(f('-x^2', { x: 3 })).toBe(-9)
    expect(f('x / 2 / 2', { x: 8 })).toBe(2)
  })
  it('隐式乘法、常量与函数', () => {
    expect(f('2x', { x: 3 })).toBe(6)
    expect(f('2(x+1)', { x: 1 })).toBe(4)
    expect(f('(x+1)(x-1)', { x: 3 })).toBe(8)
    expect(f('x sin(x)', { x: 0 })).toBe(0)
    expect(f('sin(pi/2)')).toBeCloseTo(1)
    expect(f('ln(e)')).toBeCloseTo(1)
    expect(f('sqrt(abs(-16))')).toBe(4)
    expect(f('a*x^2 + b', { x: 2, a: 0.5, b: 1 }, ['x', 'a', 'b'])).toBe(3)
    expect(f('2π')).toBeCloseTo(2 * Math.PI)
  })
  it('拒绝任意代码与未知名称', () => {
    expect(() => parseExpression('alert(1)', ['x'])).toThrow(/未知的名称/)
    expect(() => parseExpression('constructor', ['x'])).toThrow(/未知的名称/)
    expect(() => parseExpression('constructor(1)', ['x'])).toThrow(/未知的名称/)
    expect(() => parseExpression('toString(x)', ['x'])).toThrow(/未知的名称/)
    expect(() => parseExpression('x; 1', ['x'])).toThrow(/不支持的字符/)
    expect(() => parseExpression('Math.PI', ['x'])).toThrow()
    expect(() => parseExpression('(x+1', ['x'])).toThrow(/缺少/)
    expect(() => parseExpression('x +', ['x'])).toThrow(/不完整/)
    expect(() => parseExpression('y', ['x'])).toThrow(/未知的名称“y”/)
  })
})

describe('图的校验', () => {
  it('函数图：参数范围与表达式', () => {
    const ok = GraphDataSchema.parse({
      title: '二次函数平移',
      graph: {
        type: 'function',
        functions: [{ expr: 'a(x-h)^2' }],
        params: [
          { name: 'a', min: -2, max: 2, value: 1 },
          { name: 'h', min: -3, max: 3, value: 0 }
        ]
      }
    })
    expect(checkGraph(ok)).toBeNull()
    expect(graphText(ok)).toContain('y = a(x-h)^2')
    const bad = GraphDataSchema.parse({ graph: { type: 'function', functions: [{ expr: 'k*x' }] } })
    expect(checkGraph(bad)).toMatch(/无法解析/)
    const range = GraphDataSchema.parse({
      graph: { type: 'function', functions: [{ expr: 'a*x' }], params: [{ name: 'a', min: 2, max: 1, value: 1 }] }
    })
    expect(checkGraph(range)).toMatch(/范围或取值/)
  })
  it('几何图：引用顺序与类型', () => {
    const tri = GraphDataSchema.parse({
      graph: {
        type: 'geometry',
        elements: [
          { type: 'point', id: 'A', x: 0, y: 0 },
          { type: 'point', id: 'B', x: 4, y: 0 },
          { type: 'point', id: 'C', x: 1, y: 3 },
          { type: 'polygon', id: 'T', points: ['A', 'B', 'C'] },
          { type: 'segment', id: 'AB', from: 'A', to: 'B' },
          { type: 'perpendicular', id: 'h', line: 'AB', through: 'C' },
          { type: 'midpoint', id: 'M', of: ['A', 'B'] }
        ]
      }
    })
    expect(checkGraph(tri)).toBeNull()
    const order = GraphDataSchema.parse({
      graph: {
        type: 'geometry',
        elements: [
          { type: 'segment', id: 's', from: 'A', to: 'B' },
          { type: 'point', id: 'A', x: 0, y: 0 }
        ]
      }
    })
    expect(checkGraph(order)).toMatch(/尚未定义/)
    const kind = GraphDataSchema.parse({
      graph: {
        type: 'geometry',
        elements: [
          { type: 'point', id: 'A', x: 0, y: 0 },
          { type: 'point', id: 'B', x: 1, y: 0 },
          { type: 'perpendicular', id: 'p', line: 'A', through: 'B' }
        ]
      }
    })
    expect(checkGraph(kind)).toMatch(/直线或线段/)
  })
})
