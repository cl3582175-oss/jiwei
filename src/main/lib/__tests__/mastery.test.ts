import { describe, expect, it } from 'vitest'
import { cardSolid, noteStatus } from '../mastery'

describe('mastery status', () => {
  it('classifies notes from their review cards', () => {
    expect(noteStatus({ cards: 0, reviewed: 0, recall: null, stability: null })).toBe('blank')
    expect(noteStatus({ cards: 3, reviewed: 0, recall: null, stability: null })).toBe('new')
    expect(noteStatus({ cards: 3, reviewed: 3, recall: 0.5, stability: 2 })).toBe('weak')
    expect(noteStatus({ cards: 3, reviewed: 2, recall: 0.92, stability: 5 })).toBe('learning')
    expect(noteStatus({ cards: 3, reviewed: 3, recall: 0.93, stability: 40 })).toBe('solid')
  })

  it('needs both recall and stability to count a card as solid', () => {
    expect(cardSolid(0.95, 30)).toBe(true)
    expect(cardSolid(0.95, 3)).toBe(false)
    expect(cardSolid(0.6, 60)).toBe(false)
  })
})
