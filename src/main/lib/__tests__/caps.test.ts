import { describe, expect, it } from 'vitest'
import { estimateCost, isDeepSeekPeak, resolveCaps } from '@shared/ai'

describe('model capabilities', () => {
  it('detects from the name', () => {
    expect(resolveCaps('deepseek-flash').vision).toBe(true)
    expect(resolveCaps('deepseek-v4-flash').vision).toBe(true)
    expect(resolveCaps('deepseek-v4-pro')).toMatchObject({ vision: false, tier: 'strong' })
    expect(resolveCaps('deepseek-flash').tier).toBe('basic')
    expect(resolveCaps('some-unknown-model')).toMatchObject({ vision: false, tier: 'basic' })
  })

  it('user settings win, auto is kept for display', () => {
    const c = resolveCaps('deepseek-flash', { 'deepseek-flash': { tier: 'strong' }, other: { vision: true } })
    expect(c).toEqual({ vision: true, tier: 'strong', auto: { vision: true, tier: 'basic' } })
    expect(resolveCaps('my-local-llava-ish', { 'my-local-llava-ish': { vision: true } }).vision).toBe(true)
    expect(resolveCaps('gpt-5', { 'gpt-5': { vision: false } }).vision).toBe(false)
  })
})

describe('DeepSeek off-peak pricing', () => {
  const u = { inputTokens: 1_000_000, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 }
  it('halves the price outside peak hours', () => {
    const peak = Date.UTC(2026, 9, 8, 2) // 周四 UTC 02:00
    const night = Date.UTC(2026, 9, 8, 14) // 周四 UTC 14:00
    const weekend = Date.UTC(2026, 9, 10, 2) // 周六
    expect(isDeepSeekPeak(peak)).toBe(true)
    expect(isDeepSeekPeak(night)).toBe(false)
    expect(isDeepSeekPeak(weekend)).toBe(false)
    expect(estimateCost('deepseek-flash', u, peak)).toBeCloseTo(0.3)
    expect(estimateCost('deepseek-flash', u, night)).toBeCloseTo(0.15)
    expect(estimateCost('unknown', u, peak)).toBeNull()
  })
})
