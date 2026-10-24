import { describe, expect, it } from 'vitest'
import { SettingsPatchSchema } from '../schemas'

describe('settings leaf patches', () => {
  it('accepts one review leaf without requiring a stale copy of its sibling', () => {
    expect(SettingsPatchSchema.parse({ review: { newPerDay: 30 } })).toEqual({ review: { newPerDay: 30 } })
    expect(SettingsPatchSchema.parse({ review: { retention: 0.95 } })).toEqual({ review: { retention: 0.95 } })
  })

  it('accepts one reflection leaf without inserting defaults into the patch', () => {
    expect(SettingsPatchSchema.parse({ reflection: { daily: false } })).toEqual({ reflection: { daily: false } })
    expect(SettingsPatchSchema.parse({ reflection: { time: '09:30' } })).toEqual({ reflection: { time: '09:30' } })
  })

  it('continues to accept full review and reflection payloads', () => {
    const patch = {
      review: { newPerDay: 50, retention: 0.85 },
      reflection: { daily: false, weekly: true, weeklyDay: 6, time: '19:45' }
    }
    expect(SettingsPatchSchema.parse(patch)).toEqual(patch)
  })

  it('keeps the existing validation bounds for supplied leaves', () => {
    for (const patch of [
      { review: { newPerDay: -1 } },
      { review: { retention: 0.99 } },
      { reflection: { daily: 'false' } },
      { reflection: { weeklyDay: 7 } },
      { reflection: { time: 'noon' } }
    ])
      expect(SettingsPatchSchema.safeParse(patch).success).toBe(false)
  })

  it('keeps replacement arrays as explicit values rather than partial indexed objects', () => {
    expect(SettingsPatchSchema.parse({ browser: { aiBlockedSites: [] } })).toEqual({ browser: { aiBlockedSites: [] } })
    expect(SettingsPatchSchema.safeParse({ browser: { aiBlockedSites: { 0: 'example.com' } } }).success).toBe(false)
  })
})
