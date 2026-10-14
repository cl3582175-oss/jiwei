import { expect, it } from 'vitest'
import { compileExpr } from '../expr'

it('拒绝原型链上的函数名，不能把 constructor 当白名单函数', () => {
  expect(compileExpr('constructor(1)', []).ok).toBe(false)
})

it.each([
  ['2+3*4', 14],
  ['2^3^2', 512],
  ['-2^2', 4],
  ['8%3', 2],
  ['1e2 + .5', 100.5],
  ['3>2 ? 4 : 5', 4],
  ['1==2 ? 3 : 4', 4],
  ['1!=2', 1],
  ['round(1.235,2)', 1.24],
  ['min(3,2,1)+max(1,4)', 5],
  ['abs(-2)+sqrt(9)+floor(2.9)+ceil(2.1)', 10],
  ['pow(2,3)', 8],
  ['pmt(0,10,100)', 10],
  ['pmt(0.0031/12,360,1000000)', 2909.304761640859]
])('安全计算 %s', (src, want) => {
  const c = compileExpr(src, [])
  expect(c.ok).toBe(true)
  if (c.ok) expect(c.run({})).toBeCloseTo(want, 2)
})
it.each([
  'window.alert(1)',
  'constructor',
  'sqrt(1,2)',
  'pow(2)',
  'round()',
  'unknown(1)',
  'x+1',
  'a[0]',
  '1;2',
  '1 && 2',
  '('.repeat(33) + '1' + ')'.repeat(33),
  '1+'.repeat(101) + '1'
])('拒绝非白名单表达式 %s', (src) => {
  expect(compileExpr(src, []).ok).toBe(false)
})
it('变量来自声明，非有限结果交给界面显示横线，三元只算选中分支', () => {
  const c = compileExpr('x>0 ? x*2 : 1/0', ['x'])
  if (!c.ok) throw new Error(c.error)
  expect(c.run({ x: 3 })).toBe(6)
  expect(c.run({ x: 0 })).toBe(Infinity)
  expect(c.run({})).toBe(Infinity)
})
