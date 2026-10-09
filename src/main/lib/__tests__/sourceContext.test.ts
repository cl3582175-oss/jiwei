import { describe, expect, it } from 'vitest'
import { sourceContextHits, type ContextSource } from '../sourceContext'

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
