import { describe, expect, it } from 'vitest'
import { sourceContextHits, type ContextSource } from '../sourceContext'
import * as context from '../sourceContext'

const source = (id: string, texts: string[]): ContextSource => ({
  id,
  title: `Title ${id}`,
  accessedAt: 10,
  publishedAt: null,
  deletedAt: null,
  aiExcluded: false,
  segments: texts.map((text, ordinal) => ({
    id: `${id}-${ordinal}`,
    sourceId: id,
    ordinal,
    kind: 'paragraph',
    locator: { value: `p=${ordinal}` },
    text
  }))
})

describe('explicit multi-source context citations', () => {
  it('整篇模式保留全部片段而不是前12段，预算不足时拒绝伪全文', () => {
    const texts = Array.from({ length: 20 }, (_, i) => '第' + i + '段' + '正文'.repeat(100))
    const a = source('a', texts),
      budget = texts.join('').length
    expect(sourceContextHits([a], budget, { full: true }).map((h) => h.ownerId)).toEqual(texts.map((_, i) => 'a-' + i))
    expect(sourceContextHits([a], 100, { full: true })).toEqual([])
  })
  it('全文条件按中文0.7及其他字符四分之一计词元，最多5份且不超上下文40%或60000', () => {
    expect(context.estimateTokens('汉字abcd')).toBeCloseTo(2.4)
    expect(context.fullSourceFits([source('a', ['文'.repeat(1000)])], 2000)).toBe(true)
    expect(context.fullSourceFits([source('a', ['文'.repeat(1200)])], 2000)).toBe(false)
    expect(
      context.fullSourceFits(
        Array.from({ length: 6 }, (_, i) => source('s' + i, ['短文'])),
        128000
      )
    ).toBe(false)
    expect(context.fullSourceFits([source('a', ['文'.repeat(90000)])], 1000000)).toBe(false)
    expect(context.fullSourceFits([source('a', [])], 128000)).toBe(false)
    expect(context.fullSourceFits([{ ...source('a', ['短文']), aiExcluded: true }], 128000)).toBe(false)
  })
  it('includes successive source segments with their own source and segment identity', () => {
    const hits = sourceContextHits([source('a', ['first A', 'second A']), source('b', ['first B', 'second B'])])
    expect(hits.map((hit) => [hit.parentId, hit.ownerId, hit.text, hit.locator])).toEqual([
      ['a', 'a-0', 'first A', 'p=0'],
      ['a', 'a-1', 'second A', 'p=1'],
      ['b', 'b-0', 'first B', 'p=0'],
      ['b', 'b-1', 'second B', 'p=1']
    ])
  })

  it('excludes private or deleted sources even when they were explicitly selected', () => {
    expect(
      sourceContextHits([
        { ...source('secret', ['private']), aiExcluded: true },
        { ...source('deleted', ['removed']), deletedAt: 12 },
        source('public', ['readable'])
      ]).map((hit) => hit.parentId)
    ).toEqual(['public'])
  })

  it('shares the text budget between sources instead of letting the first page crowd out the second', () => {
    const hits = sourceContextHits([source('a', ['A'.repeat(10000)]), source('b', ['B'.repeat(10000)])], 2000)
    expect(hits.map((hit) => [hit.parentId, hit.text.length])).toEqual([
      ['a', 1000],
      ['b', 1000]
    ])
    expect(hits[0].text).toBe('A'.repeat(999) + '…')
  })

  it('does not duplicate a source and does not use a segment from another source', () => {
    const a = source('a', ['valid'])
    a.segments.push(source('b', ['foreign']).segments[0])
    expect(sourceContextHits([a, a]).map((hit) => hit.ownerId)).toEqual(['a-0'])
  })
})
