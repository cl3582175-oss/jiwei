import { expect, it } from 'vitest'
import { matrixTotals } from '../advisor'

it('决策选项标识是数据，原型同名标识仍得到正确加权分数', () => {
  const totals = matrixTotals(
    {
      options: [{ id: '__proto__' }, { id: 'b' }],
      criteria: [
        { name: '效率', weight: 3 },
        { name: '熟练', weight: 2 }
      ],
      scores: [
        { option: '__proto__', criterion: '效率', score: 5 },
        { option: '__proto__', criterion: '熟练', score: 2 },
        { option: 'b', criterion: '效率', score: 3 },
        { option: 'b', criterion: '熟练', score: 5 }
      ]
    },
    { 效率: 4, 熟练: 2 }
  )
  expect(totals['__proto__']).toBe(80)
  expect(totals.b).toBe(73)
  expect(Object.hasOwn(totals, '__proto__')).toBe(true)
})
