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
})
