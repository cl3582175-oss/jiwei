import { describe, expect, it } from 'vitest'
import { shortGloss, readingParts } from './reading'

describe('shortGloss', () => {
  it('keeps the first Chinese sense and drops notes', () => {
    expect(shortGloss('复习演练；排练')).toBe('复习演练')
    expect(shortGloss('产生（结果）')).toBe('产生')
    expect(shortGloss('树')).toBe('树')
  })
  it('rejects non-Chinese or overlong glosses', () => {
    expect(shortGloss('to yield')).toBeNull()
    expect(shortGloss('一个非常非常长而且完全不适合放在注释里的解释')).toBeNull()
  })
})

describe('readingParts', () => {
  it('splits long paragraphs at sentence ends', () => {
    const sentence = 'This sentence is about independent minds and careful work. '
    const parts = readingParts(sentence.repeat(60), 2400)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.trim()).toMatch(/\.$/)
  })
})
