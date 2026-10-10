import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { bigramOverlap, nearVerbatim, validateEvidence, EVIDENCE_MIN_OVERLAP } from '../lensEvidence'
import type { EvidenceSentence, LensItem } from '@shared/lens'

const sentences: EvidenceSentence[] = [
  {
    ref: 'u1',
    segmentId: 's1',
    start: 0,
    end: 6,
    speaker: 'S01',
    name: '老李',
    personId: 'p1',
    text: '决定下周试用新的预算流程，老李明天准备预算表。'
  },
  {
    ref: 'u2',
    segmentId: 's2',
    start: 7,
    end: 12,
    speaker: 'S02',
    name: '王老师',
    personId: 'p2',
    text: '间隔重复需要在快要遗忘时复习，这是本次考试的重点。'
  }
]
const item = (body: string, evidence = ['u1']): LensItem => ({ id: 'i1', category: 'decision', title: '决定', body, evidence })
describe('lens evidence admission', () => {
  it('records fixture and fabricated evidence overlap calibration', () => {
    const meeting = JSON.parse(readFileSync('e2e/fixtures/lens-meeting.json', 'utf8')) as { lines: string[] }
    const scores = {
      supported: bigramOverlap('决定下周试用新的预算流程，只在研发组试用一周。', meeting.lines[6]),
      paraphrase: bigramOverlap('研发组下周先试用一周预算流程。', meeting.lines[6]),
      fabricated: bigramOverlap('火星基地已经成功发射核聚变宇宙飞船。', meeting.lines[6]),
      misplaced: bigramOverlap('間隔重复需要在快要遗忘时复习。', meeting.lines[10]),
      verbatim: nearVerbatim('决定下周试用新的预算流程', meeting.lines[6]),
      rewritten: nearVerbatim('全公司明年正式上线预算自动审批', meeting.lines[6])
    }
    expect(scores.supported).toBe(1)
    expect(scores.paraphrase).toBeGreaterThanOrEqual(EVIDENCE_MIN_OVERLAP)
    expect(scores.fabricated).toBeLessThan(EVIDENCE_MIN_OVERLAP)
    expect(scores.misplaced).toBeLessThan(EVIDENCE_MIN_OVERLAP)
    expect(scores.verbatim).toBe(true)
    expect(scores.rewritten).toBe(false)
    console.log('LENS_EVIDENCE_CALIBRATION', JSON.stringify(scores))
  })
  it('keeps supported items and removes only invalid short references', async () => {
    const result = await validateEvidence([item('下周试用新的预算流程', ['u1', 'u999'])], sentences)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].evidence).toEqual(['u1'])
    expect(bigramOverlap('下周试用新的预算流程', sentences[0].text)).toBeGreaterThanOrEqual(EVIDENCE_MIN_OVERLAP)
  })
  it('drops invented references, fabricated content and displaced evidence with reasons', async () => {
    const result = await validateEvidence(
      [
        item('下周试用新的预算流程', ['u999']),
        { ...item('火星基地已经成功完成核聚变发动机发射'), id: 'i2' },
        { ...item('间隔重复需要在快要遗忘时复习', ['u1']), id: 'i3' }
      ],
      sentences
    )
    expect(result.items).toHaveLength(0)
    expect(result.dropped.map((d) => d.reason)).toEqual(['missing_reference', 'irrelevant', 'irrelevant'])
  })
  it('uses an explicitly supplied local vector fallback at 0.45 only', async () => {
    const value = item('间距式回忆练习', ['u2'])
    expect((await validateEvidence([value], sentences, async () => 0.44)).items).toHaveLength(0)
    expect((await validateEvidence([value], sentences, async () => 0.45)).items).toHaveLength(1)
  })
  it('accepts punctuation changes but removes rewritten verbatim fields', async () => {
    expect(nearVerbatim('在快要遗忘时复习', sentences[1].text)).toBe(true)
    expect(nearVerbatim('在完全忘记之后才重新学习', sentences[1].text)).toBe(false)
    const r = await validateEvidence([{ ...item('间隔重复需要在快要遗忘时复习', ['u2']), quote: '在完全忘记之后才重新学习' }], sentences)
    expect(r.items[0].quote).toBeUndefined()
    expect(r.dropped[0]).toMatchObject({ reason: 'rewritten_quote', field: 'quote' })
  })
})
