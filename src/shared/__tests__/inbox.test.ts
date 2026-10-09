import { describe, expect, it } from 'vitest'
import { normalizeSuggestion, relativeDueAt, phoneGroups, nextOffPeak, scheduleDay } from '../inbox'

describe('inbox suggestions', () => {
  it('downgrades unknown notes and drops unknown goals', () => {
    const result = normalizeSuggestion(
      { type: 'idea', action: 'append_note', noteId: 'foreign', goalId: 'foreign', reason: 'reason' },
      [],
      [],
      0
    )
    expect(result.action).toBe('new_note')
    expect(result.noteId).toBeUndefined()
    expect(result.goalId).toBeUndefined()
  })
  it('anchors relative dates to capture time across midnight', () => {
    const captured = new Date(2026, 9, 9, 23, 50).getTime()
    expect(relativeDueAt('明天', captured)).toBe('2026-10-10')
    expect(relativeDueAt('in 3 days', captured)).toBe('2026-10-12')
    expect(relativeDueAt('2026-02-30', captured)).toBeUndefined()
  })
  it('groups only same phone session in bounded chronological groups', () => {
    const items = [
      { id: 'a', createdAt: 0, origin: { device: 'phone' as const, sessionId: 'one' } },
      { id: 'b', createdAt: 1, origin: { device: 'phone' as const, sessionId: 'one' } },
      { id: 'c', createdAt: 2, origin: { device: 'phone' as const, sessionId: 'two' } }
    ]
    expect(phoneGroups(items)).toEqual([['a', 'b'], ['c']])
  })
  it('schedules once per local day and delays without occupying a worker', () => {
    expect(scheduleDay(new Date(2026, 9, 9, 20, 59), '21:00', null)).toBeNull()
    expect(scheduleDay(new Date(2026, 9, 9, 21), '21:00', '2026-10-09')).toBeNull()
    expect(scheduleDay(new Date(2026, 9, 9, 22), '21:00', null)).toBe('2026-10-09')
    expect(new Date(nextOffPeak(Date.parse('2026-10-09T02:00:00Z'))).toISOString()).toBe('2026-10-09T04:00:00.000Z')
  })
})

describe('phone grouping boundaries', () => {
  const phone = (id: string, minutes: number) => ({
    id,
    createdAt: minutes * 60_000,
    origin: { device: 'phone' as const, sessionId: 'session' }
  })
  it('keeps consecutive pages at five minute intervals and splits larger gaps', () => {
    expect(phoneGroups([phone('a', 0), phone('b', 5), phone('c', 10), phone('d', 16)])).toEqual([['a', 'b', 'c'], ['d']])
  })
  it('caps each group at ten and never groups unscoped phone or desktop captures', () => {
    expect(phoneGroups(Array.from({ length: 11 }, (_, i) => phone(String(i), i)))).toHaveLength(2)
    expect(
      phoneGroups([
        { id: 'a', createdAt: 0, origin: { device: 'phone' } },
        { id: 'b', createdAt: 1, origin: { device: 'phone' } }
      ])
    ).toEqual([['a'], ['b']])
  })
})
