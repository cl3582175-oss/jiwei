import { describe, expect, it } from 'vitest'
import {
  FADE_DAYS,
  MASTERY_START,
  classifyEdit,
  extractJson,
  isConceptLike,
  looksSensitive,
  masteryLevel,
  nextMastery,
  normConcept,
  shouldFade,
  similarity
} from '../learner'

describe('learner model', () => {
  it('moves mastery with signals', () => {
    expect(masteryLevel(MASTERY_START)).toBe('learning')
    const confused = nextMastery(MASTERY_START, 'confused')
    expect(masteryLevel(confused)).toBe('weak')
    let m = confused
    for (let i = 0; i < 4; i++) m = nextMastery(m, 'understood')
    expect(masteryLevel(m)).toBe('solid')
    expect(nextMastery(0.5, 'asked')).toBeLessThan(0.5)
    expect(nextMastery(0.99, 'understood')).toBeLessThanOrEqual(1)
  })

  it('normalises concept names and filters selections', () => {
    expect(normConcept('「边际 效用」')).toBe(normConcept('边际效用'))
    expect(normConcept('Ｓpaced Repetition')).toBe('spacedrepetition')
    expect(isConceptLike('边际效用')).toBe(true)
    expect(isConceptLike('这是一整句话。')).toBe(false)
    expect(isConceptLike('一')).toBe(false)
  })
})

describe('edit classification', () => {
  it('scores similar text', () => {
    expect(similarity('间隔重复对抗遗忘', '间隔重复对抗遗忘')).toBe(1)
    expect(similarity('间隔重复对抗遗忘', '完全不同的内容')).toBeLessThan(0.2)
  })

  it('tells kept, edited and deleted apart', () => {
    const before = '间隔重复：在即将遗忘时复习，间隔逐渐拉长，用最少的复习次数记得最久。'
    expect(classifyEdit(before, ['别的段落', before]).kind).toBe('kept')
    const edited = classifyEdit(before, ['间隔重复：快忘时复习，间隔逐渐拉长。'])
    expect(edited.kind).toBe('edited')
    expect(edited.after).toContain('快忘时')
    expect(classifyEdit(before, ['今天天气不错']).kind).toBe('deleted')
  })
})

describe('sensitive and fading', () => {
  it('flags sensitive content', () => {
    expect(looksSensitive('最近在吃抗焦虑的药')).toBe(true)
    expect(looksSensitive('喜欢先看例子')).toBe(false)
  })

  it('fades only old, unused, unpinned AI memories', () => {
    const now = Date.now()
    const old = now - (FADE_DAYS + 1) * 86_400_000
    const base = { kind: 'preference' as const, origin: 'ai', pinned: false, status: 'active', updatedAt: old, lastUsedAt: null }
    expect(shouldFade(base, now)).toBe(true)
    expect(shouldFade({ ...base, lastUsedAt: now - 86_400_000 }, now)).toBe(false)
    expect(shouldFade({ ...base, pinned: true }, now)).toBe(false)
    expect(shouldFade({ ...base, origin: 'user' }, now)).toBe(false)
    expect(shouldFade({ ...base, kind: 'episode' }, now)).toBe(false)
  })
})

describe('extractJson', () => {
  it('reads fenced or bare JSON', () => {
    expect(extractJson('好的：\n```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('result {"b":[1,2]} done')).toEqual({ b: [1, 2] })
    expect(() => extractJson('no json')).toThrow()
  })
})
