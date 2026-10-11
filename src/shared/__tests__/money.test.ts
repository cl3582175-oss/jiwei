import { describe, expect, it } from 'vitest'
import { currencySymbol, defaultMoney, displayCurrency, formatAmount, formatMoney, fromUsd, rateOf, toUsd } from '../money'
import { estimateCost, offPeakSaving, priceCost, resolvePrice } from '../ai'

const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, reasoningTokens: 0, cachedInputTokens: 0 }

describe('money', () => {
  it('converts with built-in and overridden rates', () => {
    expect(rateOf('USD')).toBe(1)
    expect(rateOf('CNY')).toBeGreaterThan(5)
    expect(rateOf('XXX')).toBeNull()
    expect(toUsd(67.069, 'CNY')).toBeCloseTo(10, 2)
    expect(fromUsd(10, 'CNY', { rates: { CNY: 7 } })).toBe(70)
    expect(toUsd(1, 'XXX')).toBeNull()
  })

  it('falls back to USD when the display currency has no rate', () => {
    expect(displayCurrency({ currency: 'XAF', rates: {} })).toBe('USD')
    expect(displayCurrency({ currency: 'XAF', rates: { XAF: 600 } })).toBe('XAF')
  })

  it('formats small amounts with significant digits and larger ones with cents', () => {
    expect(formatAmount(0.0034, 'CNY', 'zh-CN')).toBe('¥0.0034')
    expect(formatAmount(12.5, 'CNY', 'zh-CN')).toBe('¥12.50')
    expect(formatAmount(0.7, 'CNY', 'zh-CN')).toBe('¥0.70')
    expect(formatAmount(0, 'USD', 'en')).toBe('$0')
    expect(formatMoney(1, { currency: 'CNY', rates: { CNY: 7 } }, 'zh-CN')).toBe('¥7.00')
    expect(currencySymbol('EUR', 'en')).toBe('€')
  })

  it('defaults to CNY for Chinese and USD otherwise', () => {
    expect(defaultMoney('zh-CN').currency).toBe('CNY')
    expect(defaultMoney('en').currency).toBe('USD')
    expect(defaultMoney().alertAt).toBe(0.8)
  })
})

describe('model prices', () => {
  it('resolves built-in prices, dated snapshots and custom overrides', () => {
    expect(resolvePrice('gpt-5.4')?.source).toBe('official')
    expect(resolvePrice('gpt-5.4-2026-03-05')?.price.input).toBe(2.5)
    expect(resolvePrice('claude-sonnet-4-5-20250929')?.price.output).toBe(15)
    expect(resolvePrice('glm-5.3')?.source).toBe('reference')
    expect(resolvePrice('my-local-model')).toBeNull()
    const custom = { currency: 'CNY', input: 1, output: 2 }
    expect(resolvePrice('gpt-5.4', custom)).toEqual({ price: custom, source: 'custom' })
  })

  it('converts non-USD list prices to USD', () => {
    // kimi-k2.6：输入 ¥6.5、输出 ¥27 / 百万
    expect(priceCost(resolvePrice('kimi-k2.6')!.price, usage)).toBeCloseTo(33.5)
    expect(estimateCost('kimi-k2.6', usage, Date.now(), null, { rates: { CNY: 6.7 } })).toBeCloseTo(5)
    expect(estimateCost('x', usage, Date.now(), { currency: 'XXX', input: 1, output: 1 })).toBeNull()
  })

  it('counts cache hits at the cached price', () => {
    const p = { currency: 'USD', input: 2, cachedInput: 0.2, output: 10 }
    expect(priceCost(p, { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 0, reasoningTokens: 0 })).toBeCloseTo(1.1)
  })

  it('reports DeepSeek off-peak savings only off-peak', () => {
    const p = resolvePrice('deepseek-flash')!.price
    const peak = Date.parse('2026-10-07T02:00:00Z')
    const night = Date.parse('2026-10-07T14:00:00Z')
    expect(offPeakSaving(p, usage, peak)).toBe(0)
    expect(offPeakSaving(p, usage, night)).toBeCloseTo(0.75)
  })
})
