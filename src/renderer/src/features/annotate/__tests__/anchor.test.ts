import { describe, expect, it } from 'vitest'
import { locateQuote } from '../anchor'

describe('annotation re-anchoring (TextQuote)', () => {
  const text = '间隔重复让记忆更持久。提取练习也让记忆更持久。'

  it('keeps the original position when the text has not changed', () => {
    expect(locateQuote(text, { quote: '记忆更持久', start: 5 })).toEqual({ start: 5, end: 10 })
  })

  it('picks the occurrence whose context matches after the text moved', () => {
    const moved = '前言。' + text
    // 原来在“提取练习也让”之后的那一处
    expect(locateQuote(moved, { quote: '记忆更持久', prefix: '提取练习也让', suffix: '。', start: 17 })).toEqual({ start: 20, end: 25 })
  })

  it('prefers the occurrence closest to the old position when context ties', () => {
    expect(locateQuote(text, { quote: '记忆更持久', start: 16 })).toEqual({ start: 17, end: 22 })
  })

  it('returns null when the quote is gone', () => {
    expect(locateQuote(text, { quote: '交错练习', start: 0 })).toBeNull()
    expect(locateQuote(text, {})).toBeNull()
  })
  it('matches extraction-normalized native quotes while preserving original UTF16 offsets', () => {
    expect(locateQuote('前言 风压A102。', { quote: '⻛压Ａ１０２' })).toEqual({ start: 3, end: 9 })
    expect(locateQuote('前言 风\u200b压Ａ１０２。', { quote: '风压A102' })).toEqual({ start: 3, end: 10 })
    expect(locateQuote('😀⻛压Ａ１０２', { quote: '风压A102' })).toEqual({ start: 2, end: 8 })
    expect(locateQuote('前言\u{2F800}风压', { quote: '丽风压' })).toEqual({ start: 2, end: 6 })
  })
})
