import { describe, expect, it } from 'vitest'
import { SettingsPatchSchema } from '../schemas'

describe('retrieval settings patches', () => {
  it('retains a partial retrieval patch without replacing unrelated defaults', () => {
    expect(SettingsPatchSchema.parse({ retrieval: { cautious: true, dailyLimit: 10 } })).toEqual({
      retrieval: { cautious: true, dailyLimit: 10 }
    })
  })
  it.each([9, 5001, 10.5])('rejects invalid daily limit %s', (dailyLimit) => {
    expect(SettingsPatchSchema.safeParse({ retrieval: { dailyLimit } }).success).toBe(false)
  })
  it('rejects an unknown preferred backend and an oversized trust list', () => {
    expect(SettingsPatchSchema.safeParse({ retrieval: { preferZh: 'unknown' } }).success).toBe(false)
    expect(SettingsPatchSchema.safeParse({ retrieval: { trustedSites: Array(201).fill('example.org') } }).success).toBe(false)
  })
})
