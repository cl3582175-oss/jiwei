import { describe, expect, it } from 'vitest'
import { forecastCards } from '../../services/plan/forecast'

describe('已排期的复习负荷下限', () => {
  const today = new Date(2026, 9, 11).getTime()
  it('已过期计入今天，暂停卡不计入，未排期新卡按每日上限分配', () => {
    const rows = [
      { due: today - 86400000, state: 2, suspended: false },
      { due: today + 86400000, state: 1, suspended: false },
      { due: today, state: 2, suspended: true },
      ...Array.from({ length: 5 }, () => ({ due: today, state: 0, suspended: false }))
    ]
    expect(forecastCards(rows, 3, 2, today)).toEqual([
      { date: '2026-10-11', due: 1, new: 2 },
      { date: '2026-10-12', due: 1, new: 2 },
      { date: '2026-10-13', due: 0, new: 1 }
    ])
  })
  it('每日新卡上限为零时不分配新卡', () => {
    expect(forecastCards([{ due: today, state: 0, suspended: false }], 1, 0, today)).toEqual([{ date: '2026-10-11', due: 0, new: 0 }])
  })
})
