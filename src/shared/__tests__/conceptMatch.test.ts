import { describe, expect, it } from 'vitest'
import { findConceptMatches } from '../conceptMatch'

describe('weak concept matching', () => {
  it('keeps the longest overlapping concept and returns document offsets', () => {
    expect(findConceptMatches('深度机器学习帮助机器学习。', ['机器', '学习', '机器学习', '深度机器学习'])).toEqual([
      { name: '深度机器学习', start: 0, end: 6 },
      { name: '机器学习', start: 8, end: 12 }
    ])
  })

  it('matches Latin whole words without accepting substrings or identifier fragments', () => {
    expect(findConceptMatches('Cat concatenate cat_2 CAT. cat2', ['cat'])).toEqual([
      { name: 'cat', start: 0, end: 3 },
      { name: 'cat', start: 22, end: 25 }
    ])
  })

  it('allows Chinese terms without spaces and Latin concepts beside Chinese text', () => {
    expect(findConceptMatches('理解边际效用递减，学习AI模型。', ['边际效用', 'AI'])).toEqual([
      { name: '边际效用', start: 2, end: 6 },
      { name: 'AI', start: 11, end: 13 }
    ])
  })

  it('escapes concept punctuation and preserves UTF-16 offsets across emoji', () => {
    expect(findConceptMatches('😀 C++ and a.b, axb', ['C++', 'a.b'])).toEqual([
      { name: 'C++', start: 3, end: 6 },
      { name: 'a.b', start: 11, end: 14 }
    ])
  })

  it('treats punctuation-bearing terms and Unicode letters as whole concepts', () => {
    expect(findConceptMatches('C++17 C++ .NET x.NET 𝑓 a𝑓b', ['C++', '.NET', '𝑓'])).toEqual([
      { name: 'C++', start: 6, end: 9 },
      { name: '.NET', start: 10, end: 14 },
      { name: '𝑓', start: 21, end: 23 }
    ])
  })

  it('deduplicates names, accepts wrapped whitespace, and bounds page work', () => {
    expect(findConceptMatches('Neural\n network and neural network', ['neural network', 'Neural network', ''], 1)).toEqual([
      { name: 'neural network', start: 0, end: 15 }
    ])
    expect(findConceptMatches('AI AI', ['AI'], 0)).toEqual([])
  })
})
