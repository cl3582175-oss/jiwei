import { describe, expect, it } from 'vitest'
import { relativeLensDate } from '../lensDates'
import { splitLensTranscript, mergeLensItems } from '../lensChunks'
import { resolveLensOwner, mapLensLanding, duplicateLensItems, canUndoLanding } from '../lensLanding'
import { createLensSkill, validateLensMetadata } from '../lensSkill'
import { parseSkill } from '../skillFormat'
import { sceneNeedsChoice, recordingMatches, lensActionCommitted } from '@shared/lens'
import type { EvidenceSentence, LensItem } from '@shared/lens'

describe('lens relative calendar dates', () => {
  it.each([
    ['明天', '2026-12-31', '2027-01-01'],
    ['下周三之前', '2026-10-10', '2026-10-14'],
    ['下下周一', '2026-10-10', '2026-10-19'],
    ['周天', '2026-10-10', '2026-10-11'],
    ['下周天', '2026-10-10', '2026-10-18'],
    ['下下星期天', '2026-10-10', '2026-10-25'],
    ['月底', '2028-02-10', '2028-02-29'],
    ['3号', '2026-12-28', '2027-01-03'],
    ['本周五', '2026-10-10', '2026-10-09'],
    ['next Wednesday', '2026-10-10', '2026-10-14'],
    ['the day after tomorrow', '2026-10-31', '2026-11-02'],
    ['end of next month', '2026-12-10', '2027-01-31'],
    ['2026-02-30', '2026-02-01', null],
    ['稍后找时间', '2026-10-10', null]
  ])('%s relative to %s => %s', (phrase, base, expected) => expect(relativeLensDate(phrase, base)).toBe(expected))
})
describe('lens long transcript merging', () => {
  const s: EvidenceSentence[] = Array.from({ length: 130 }, (_, i) => ({
    ref: `u${i + 1}`,
    segmentId: `s${i}`,
    start: i * 60,
    end: i * 60 + 50,
    speaker: `S0${(i % 3) + 1}`,
    name: '说话人',
    personId: null,
    text: '预算流程'.repeat(40)
  }))
  it('splits at speaker boundaries with one minute overlap and no missing sentences', () => {
    const parts = splitLensTranscript(s)
    expect(parts.length).toBeGreaterThan(1)
    expect(new Set(parts.flat().map((x) => x.ref)).size).toBe(s.length)
    expect(parts[1][0].start).toBeLessThanOrEqual(parts[0].at(-1)!.end)
    expect(parts[0].at(-1)!.speaker).not.toBe(s[parts[0].length].speaker)
  })
  it('cuts long monologues near fifteen minutes rather than waiting twenty more sentences', () => {
    const parts = splitLensTranscript(s.map((sentence) => ({ ...sentence, speaker: 'S01' })))
    expect(parts[0].at(-1)!.end - parts[0][0].start).toBeLessThanOrEqual(960)
    expect(new Set(parts.flat().map((sentence) => sentence.ref)).size).toBe(s.length)
  })
  it('merges same category and retains evidence union without merging different categories', () => {
    const a: LensItem = { id: 'a', category: 'action', title: '预算', body: '老李明天准备预算表', evidence: ['u1'] }
    const r = mergeLensItems([a, { ...a, id: 'b', evidence: ['u2'] }, { ...a, id: 'c', category: 'decision' }])
    expect(r).toHaveLength(2)
    expect(r[0].evidence).toEqual(['u1', 'u2'])
  })
  it('keeps identical viewpoints from different confirmed speakers separate', () => {
    const a: LensItem = {
      id: 'a',
      category: 'viewpoint',
      title: '预算',
      body: '准备预算表',
      evidence: ['u1'],
      speaker: 'S01',
      speakerPersonId: 'p1'
    }
    const b = { ...a, id: 'b', evidence: ['u2'], speakerPersonId: 'p2' }
    expect(mergeLensItems([a, b])).toHaveLength(2)
  })
})
describe('lens landing boundaries', () => {
  const people = [
    { id: 'p1', name: '老李' },
    { id: 'p2', name: '王老师' }
  ]
  const sentences: EvidenceSentence[] = [
    { ref: 'u1', segmentId: 's1', start: 12, end: 20, text: '准备预算表', speaker: 'S01', name: '老李', personId: 'p1' }
  ]
  const action: LensItem = {
    id: 'a',
    category: 'action',
    title: '预算',
    body: '准备预算表',
    evidence: ['u1'],
    owner: 'S01',
    dueQuote: '明天'
  }
  it('resolves speaker first then exact names, preserves unregistered text', () => {
    expect(resolveLensOwner('S01', sentences, people, ['p1'])).toEqual({ personId: 'p1', name: '老李' })
    expect(resolveLensOwner('王老师', sentences, people, [])).toEqual({ personId: 'p2', name: '王老师' })
    expect(resolveLensOwner('老李老师', sentences, people, [])).toEqual({ personId: null, name: '老李老师' })
  })
  it('uses cited sentences to resolve a corrected label and leaves ambiguous labels unresolved', () => {
    const corrected = [...sentences, { ...sentences[0], ref: 'u2', segmentId: 's2', personId: 'p2', name: '王老师' }]
    expect(
      resolveLensOwner(
        'S01',
        corrected.filter((s) => s.ref === 'u2'),
        people,
        []
      )
    ).toEqual({ personId: 'p2', name: '王老师' })
    expect(resolveLensOwner('S01', corrected, people, [])).toEqual({ personId: null, name: 'S01' })
  })
  it('maps meetings to proposal rows/actions with source timestamp provenance', () => {
    const r = mapLensLanding('meeting', [action, { ...action, id: 'd', category: 'decision' }], sentences, 'source', '2026-10-10')
    expect(r.actions).toHaveLength(1)
    expect(r.rows).toHaveLength(1)
    expect(JSON.stringify(r.ops)).toContain('jiwei://source/source?t=12')
    expect(JSON.stringify(r.ops)).toContain('source')
  })
  it('maps lecture cues to Cornell rows and concepts without creating cards directly', () => {
    const r = mapLensLanding(
      'lecture',
      [
        { ...action, category: 'row', cue: '预算表怎么准备？' },
        { ...action, id: 'c', category: 'concept' }
      ],
      sentences,
      'source',
      '2026-10-10'
    )
    expect(r.rows[0].cue).toBe('预算表怎么准备？')
    expect(r.concepts).toHaveLength(1)
    expect(r.rows).toHaveLength(1)
    expect(r.ops.filter((op) => op.op === 'insert_row')).toHaveLength(1)
    expect(JSON.stringify(r.ops)).toContain('jiwei://source/source?t=12')
  })
  it('课堂：同一段原话的问答、考点、例子并入对应行；大纲与无归属例子进总结', () => {
    const row = { ...action, id: 'r', category: 'row' as const, cue: '预算表怎么准备？', body: '保留三个必填字段。', evidence: ['u1'] }
    const r = mapLensLanding(
      'lecture',
      [
        row,
        { ...action, id: 'q', category: 'qa' as const, cue: '预算表要几个字段？', evidence: ['u1'] },
        { ...action, id: 'e', category: 'emphasis' as const, quote: '一定要保留三个字段', evidence: ['u1'] },
        { ...action, id: 'x', category: 'example' as const, title: '研发组试用', body: '只在研发组试用一周', evidence: ['u1'] },
        { ...action, id: 'o', category: 'outline' as const, evidence: ['u1'] },
        { ...action, id: 'x2', category: 'example' as const, title: '无关例子', evidence: ['u9'] },
        { ...action, id: 'q2', category: 'qa' as const, cue: '另一个问题？', evidence: ['u9'] }
      ],
      sentences,
      'source',
      '2026-10-10'
    )
    expect(r.rows.map((x) => x.cue)).toEqual(['预算表怎么准备？', '另一个问题？'])
    expect(r.rows[0].body).toMatch(/^★ 保留三个必填字段。/)
    expect(r.rows[0].body).toContain('“一定要保留三个字段”')
    expect(r.rows[0].body).toContain('例：研发组试用——只在研发组试用一周')
    expect(r.ops.filter((op) => op.op === 'append_summary')).toHaveLength(2)
  })
  it('行动项：有承诺或指派才默认勾选，讲解里的建议不算', () => {
    const base = { ...action, category: 'action' as const, owner: undefined, ownerName: undefined, dueQuote: undefined }
    const said = (text: string): EvidenceSentence[] => [{ ...sentences[0], ref: 'u1', text }]
    expect(lensActionCommitted({ ...base, body: '验收测四圈', evidence: ['u1'] }, said('可以记住四圈。'))).toBe(false)
    expect(lensActionCommitted({ ...base, body: '准备预算表', evidence: ['u1'] }, said('请小王准备预算表。'))).toBe(true)
    expect(lensActionCommitted({ ...base, body: '回顾', evidence: ['u1'], dueQuote: '下周三' }, said('回顾一下。'))).toBe(true)
    expect(lensActionCommitted({ ...base, category: 'decision' as const, body: 'x', evidence: ['u1'] }, said('x'))).toBe(true)
  })
  it('maps thought ideas to hypothesis candidates and registered links to note rows', () => {
    const r = mapLensLanding(
      'thought',
      [
        { ...action, category: 'idea' },
        { ...action, id: 'l', category: 'link', noteId: 'n1', relation: 'contradicts' }
      ],
      sentences,
      'source',
      '2026-10-10'
    )
    expect(r.insights).toHaveLength(1)
    expect(JSON.stringify(r.ops)).toContain('n1')
  })
  it('does not let a custom, append or person output create actions by choosing a category', () => {
    for (const rule of ['append', 'person', 'quiz'] as const) {
      const r = mapLensLanding(rule, [action], sentences, 'source', '2026-10-10')
      expect(r.actions).toHaveLength(0)
      expect(r.ops.length + r.personNotes.length).toBeGreaterThan(0)
    }
  })
  it('detects duplicates across versions but separates object types', () => {
    expect(duplicateLensItems([action, { ...action, id: 'd', category: 'decision' }], [action])).toEqual(['a'])
  })
  it('undo requires unmodified objects and a ten minute deadline', () => {
    expect(canUndoLanding(1000, 601000, true)).toBe(true)
    expect(canUndoLanding(1000, 601001, true)).toBe(false)
    expect(canUndoLanding(1000, 2000, false)).toBe(false)
  })
})
describe('lens skill safety and scene gates', () => {
  it('round trips hostile display data as YAML scalars using an internal directory name', () => {
    const body = '请保留 ../ 原话\n---\nmetadata:\n  output: hacked',
      title = '../例子\nkind: attack'
    const parsed = parseSkill(createLensSkill('lens-12ab34cd', title, body), 'lens-12ab34cd')
    expect(parsed.metadata.title).toBe(title)
    expect(parsed.body).toBe(body)
    expect(validateLensMetadata(parsed.metadata)).toMatchObject({ output: 'items', landing: 'append' })
    expect(() => createLensSkill('../outside', title, body)).toThrow()
  })
  it('rejects unknown kind/output/landing values and excessive inputs', () => {
    expect(() => validateLensMetadata({ kind: 'lens', output: 'shell', landing: 'append' })).toThrow()
    expect(() => createLensSkill('lens-12ab34cd', '名'.repeat(41), '指令')).toThrow()
    expect(() => createLensSkill('lens-12ab34cd', '名字', '令'.repeat(2001))).toThrow()
  })
  it('requires an explicit choice below confidence 0.75', () => {
    expect(sceneNeedsChoice('unspecified', { scene: 'meeting', confidence: 0.74, reason: '' })).toBe(true)
    expect(sceneNeedsChoice('unspecified', { scene: 'meeting', confidence: 0.75, reason: '' })).toBe(false)
    expect(sceneNeedsChoice('lecture', null)).toBe(false)
  })
  it('combines person scene series and date filters while excluding local-only material', () => {
    const meta = {
      personIds: ['p1'],
      scene: 'meeting',
      seriesId: 's1',
      startedAt: Date.parse('2026-10-10T12:00:00Z'),
      localOnly: false,
      deleted: false
    }
    expect(recordingMatches(meta, { personId: 'p1', scene: 'meeting', seriesId: 's1', from: '2026-10-10', to: '2026-10-10' })).toBe(true)
    expect(recordingMatches({ ...meta, localOnly: true }, {})).toBe(false)
    expect(recordingMatches(meta, { personId: 'other' })).toBe(false)
  })
})
