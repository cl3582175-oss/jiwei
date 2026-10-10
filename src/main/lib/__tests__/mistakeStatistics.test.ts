import { expect, it } from 'vitest'
import { summarizeMistakes } from '../mistakeStatistics'
it('uses all actual rows as denominator and counts each concept once per mistake', () => {
  const result = summarizeMistakes([
    { cause: 'calculation', verified: true, concepts: ['Equations', 'Equations', 'Units'] },
    { cause: 'reading', verified: false, concepts: ['Units'] },
    { cause: 'unknown', verified: false, concepts: [] }
  ])
  expect(result.total).toBe(3)
  expect(result.verifiedRatio).toBeCloseTo(1/3)
  expect(result.causes.find((c) => c.cause === 'calculation')).toEqual({ cause: 'calculation', count: 1, percentage: 100/3 })
  expect(result.concepts).toEqual([{ name: 'Units', count: 2 }, { name: 'Equations', count: 1 }])
  expect(summarizeMistakes([]).verifiedRatio).toBe(0)
})
