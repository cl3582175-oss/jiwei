import { describe, expect, it } from 'vitest'
import { ConceptDescribeSchema, ConceptPageSchema, conceptExcerpt } from '../browserConcepts'

describe('concept message and local explanation boundaries', () => {
  it('rejects unbounded, non-web and malformed page messages', () => {
    expect(ConceptPageSchema.safeParse({ url: 'https://learn.test/topic' }).success).toBe(true)
    for (const raw of [
      null,
      [],
      { url: 'file:///private' },
      { url: 'javascript:alert(1)' },
      { url: 1 },
      { url: 'https://a.test', name: 'unrequested' }
    ])
      expect(ConceptPageSchema.safeParse(raw).success).toBe(false)
    for (const name of ['', 'x'.repeat(41), 12, { name: 'AI' }])
      expect(ConceptDescribeSchema.safeParse({ url: 'https://learn.test', name }).success).toBe(false)
  })

  it('returns an exact bounded excerpt around the concept without inventing an explanation', () => {
    const note = '前言'.repeat(180) + '\n机器学习通过样本训练模型，再对新样本作出预测。\n' + '后记'.repeat(180)
    const excerpt = conceptExcerpt(note, '机器学习')
    expect(excerpt).toContain('机器学习通过样本训练模型')
    expect(excerpt?.length).toBeLessThanOrEqual(200)
    expect(note).toContain(excerpt)
    expect(conceptExcerpt('concatenate is not a cat explanation', 'cat')).toBe('concatenate is not a cat explanation')
    expect(conceptExcerpt('concatenate alone', 'cat')).toBeNull()
  })
})
