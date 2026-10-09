import { describe, expect, it } from 'vitest'
import { ftsQuery, isStopTrigram } from '../fts'

describe('keyword query', () => {
  it('drops trigrams made of question words', () => {
    expect(isStopTrigram('有什么')).toBe(true)
    expect(isStopTrigram('为什么')).toBe(true)
    expect(isStopTrigram('边际效')).toBe(false)
    const q = ftsQuery('不同题型混着练有什么好处')!
    expect(q).not.toContain('"有什么"')
    expect(q).toContain('"不同题"')
  })

  it('keeps English words and returns null for nothing useful', () => {
    expect(ftsQuery('tuple 能当 dict 的 key 吗')).toContain('"tuple"')
    expect(ftsQuery('是什么')).toBeNull()
  })
})
