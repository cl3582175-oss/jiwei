import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocJSON, ProposalInput, Segment } from '@shared/types'
import { courseNodeText } from '../courseLearning'

// 模型输出只是单测输入；这里验证异步权限边界与提案写入，不能替代真实模型语义验收。
const state = vi.hoisted(() => ({
  source: { id: 'source', title: '课程', kind: 'web', aiExcluded: false, deletedAt: null as number | null },
  note: { id: 'note', aiExcluded: false, deletedAt: null as number | null },
  doc: { type: 'doc', content: [] } as DocJSON,
  segments: [] as Segment[],
  tab: { id: 'tab', scope: 'scope', media: 'video-1', sourceId: 'source', incognito: false, video: { currentTime: 30 } } as {
    id: string
    scope: string
    media: string | null
    sourceId: string | null
    incognito: boolean
    video: { currentTime: number } | null
  } | null,
  sensitive: false,
  sequence: 0,
  structured: vi.fn<(input: { prompt: string; schema: { parse: (value: unknown) => unknown } }) => Promise<unknown>>(),
  proposal: vi.fn<(input: ProposalInput) => { id: string }>(),
  createNote: vi.fn<() => { id: string }>(),
  courseSource: vi.fn<() => Promise<string>>()
}))

vi.mock('../../db', () => ({ getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ get: () => state.source }) }) }) }) }))
vi.mock('../../services/segments', () => ({ listSegments: () => state.segments }))
vi.mock('../../services/notes', () => ({ getNote: () => state.note, createNote: state.createNote }))
vi.mock('../../services/docs', () => ({ loadDoc: () => new Uint8Array(), stateToJSON: () => state.doc }))
vi.mock('../../services/proposals', () => ({ createProposal: state.proposal }))
vi.mock('../../services/settings', () => ({
  getSettings: () => ({ language: 'zh-CN', ai: { chat: { providerId: 'unit-test-only', model: 'unit-test-only' } } })
}))
vi.mock('../../services/ai/structured', () => ({ structured: state.structured, quickModel: (_provider: string, model: string) => model }))
vi.mock('../../services/browser/course', () => ({ courseSource: state.courseSource }))
vi.mock('../../services/browser/manager', () => ({ getTab: () => state.tab, isSensitive: () => state.sensitive }))
vi.mock('../ids', () => ({ newId: () => `question-${++state.sequence}` }))

import { checkCourseAnswer, makeCourseQuiz, organizeCourse, reviewCourseQuiz } from '../../services/browser/courseLearning'

const transcript = (start: number, text = '课堂原文', end = start + 30): Segment => ({
  id: `segment-${start}`,
  sourceId: 'source',
  ordinal: start,
  kind: 'transcript',
  locator: { value: `t=${start},${end}` },
  text
})
const row = (t = 10, body = '根据材料整理的要点') => ({ cue: '如何理解？', body, t, emphasis: false })
const outline = (t = 10, body = '根据材料整理的要点') => ({ rows: [row(t, body)], summary: '课程总结' })
const quiz = () => ({ question: '如何复习？', answer: '在快要遗忘时复习。', t: 10 })
const quickNote = (t = 20, phrase = '**原话** &amp; <保留>'): DocJSON => ({
  type: 'doc',
  content: [
    {
      type: 'cornellRow',
      attrs: { id: 'original-row' },
      content: [
        { type: 'cornellCue', content: [{ type: 'paragraph', content: [{ type: 'text', text: '我的线索' }] }] },
        {
          type: 'cornellBody',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: `▶ ${t}`, marks: [{ type: 'link', attrs: { href: `jiwei://source/source?t=${t}` } }] },
                { type: 'text', text: phrase }
              ]
            }
          ]
        }
      ]
    }
  ]
})

beforeEach(() => {
  state.source = { id: 'source', title: '课程', kind: 'web', aiExcluded: false, deletedAt: null }
  state.note = { id: 'note', aiExcluded: false, deletedAt: null }
  state.doc = { type: 'doc', content: [] }
  state.segments = [transcript(0)]
  state.tab = { id: 'tab', scope: 'scope', media: 'video-1', sourceId: 'source', incognito: false, video: { currentTime: 30 } }
  state.sensitive = false
  state.structured.mockReset()
  state.proposal.mockReset().mockReturnValue({ id: 'proposal' })
  state.createNote.mockReset().mockReturnValue({ id: 'new-note' })
  state.courseSource.mockReset().mockResolvedValue('source')
})

describe('course organization service', () => {
  it('preserves exact learner wording in append-only proposal nodes without changing existing rows', async () => {
    state.doc = quickNote()
    const original = structuredClone(state.doc)
    state.structured.mockResolvedValue(outline())
    await expect(organizeCourse('source', 'note')).resolves.toEqual({ noteId: 'note', proposalId: 'proposal' })
    const input = state.proposal.mock.calls[0][0]
    expect(input.auto).not.toBe(true)
    expect(input.ops.every((op) => op.op === 'insert_row' || op.op === 'append_summary')).toBe(true)
    const added = input.ops.find((op) => op.op === 'insert_row')!
    expect(courseNodeText({ content: added.body })).toContain('我的线索\n▶ 20**原话** &amp; <保留>')
    expect(JSON.stringify(added.body)).toContain('jiwei://source/source?t=10')
    expect(JSON.stringify(added.body)).toContain('jiwei://source/source?t=20')
    expect(state.doc).toEqual(original)
  })

  it('validates each extraction against its own chunk, not an unseen timestamp elsewhere in the course', async () => {
    state.segments = [transcript(0, '甲'.repeat(5965), 10), transcript(100, '后半课内容', 110)]
    state.structured
      .mockResolvedValueOnce(outline(100, 'UNSEEN'))
      .mockResolvedValueOnce(outline(100, '合法的后半课要点'))
      .mockResolvedValueOnce(outline(100, '最终要点'))
    await organizeCourse('source', 'note')
    expect(state.structured).toHaveBeenCalledTimes(3)
    expect(state.structured.mock.calls[0][0].prompt).toContain('[transcript t=0,10]')
    expect(state.structured.mock.calls[0][0].prompt).not.toContain('t=100')
    expect(state.structured.mock.calls[1][0].prompt).toBe('[transcript t=100,110] 后半课内容')
    expect(state.structured.mock.calls[2][0].prompt).not.toContain('UNSEEN')
    expect(state.structured.mock.calls[2][0].prompt).toContain('[t=100]')
  })

  it('stops a long course immediately when learner privacy is revoked between model calls', async () => {
    state.segments = [transcript(0, '甲'.repeat(8000))]
    state.structured.mockImplementationOnce(async () => {
      state.note.aiExcluded = true
      return outline()
    })
    await expect(organizeCourse('source', 'note')).rejects.toThrow(/excluded/)
    expect(state.structured).toHaveBeenCalledTimes(1)
    expect(state.proposal).not.toHaveBeenCalled()
  })

  it.each([
    'source-excluded',
    'source-deleted',
    'note-excluded',
    'note-deleted',
    'media',
    'scope',
    'private',
    'sensitive',
    'closed',
    'transcript',
    'quick-note'
  ])('rejects an in-flight result after %s changes', async (change) => {
    state.doc = quickNote()
    state.structured.mockImplementationOnce(async () => {
      if (change === 'source-excluded') state.source.aiExcluded = true
      if (change === 'source-deleted') state.source.deletedAt = 1
      if (change === 'note-excluded') state.note.aiExcluded = true
      if (change === 'note-deleted') state.note.deletedAt = 1
      if (change === 'media') state.tab!.media = 'video-2'
      if (change === 'scope') state.tab!.scope = 'new-scope'
      if (change === 'private') state.tab!.incognito = true
      if (change === 'sensitive') state.sensitive = true
      if (change === 'closed') state.tab = null
      if (change === 'transcript') state.segments = [transcript(0, '已经人工纠正')]
      if (change === 'quick-note') state.doc = quickNote(20, '用户在等待时已经改了原话')
      return outline()
    })
    await expect(organizeCourse('source', 'note')).rejects.toThrow()
    expect(state.proposal).not.toHaveBeenCalled()
    expect(state.createNote).not.toHaveBeenCalled()
  })

  it('allows appended transcripts without invalidating the unchanged material already supplied', async () => {
    state.structured.mockImplementationOnce(async () => {
      state.segments.push(transcript(50, '新追加'))
      return outline()
    })
    await organizeCourse('source', 'note')
    expect(state.proposal).toHaveBeenCalledOnce()
  })

  it('creates neither a note nor a proposal when model timestamps have no valid support', async () => {
    state.structured.mockResolvedValue(outline(999))
    await expect(organizeCourse('source', null)).rejects.toThrow(/时间证据/)
    expect(state.proposal).not.toHaveBeenCalled()
    expect(state.createNote).not.toHaveBeenCalled()
  })

  it('requires legal transcript evidence before sending any model request', async () => {
    state.segments = [{ ...transcript(0), locator: { value: 't=invalid' } }]
    await expect(organizeCourse('source', null)).rejects.toThrow(/文字稿/)
    expect(state.structured).not.toHaveBeenCalled()
    expect(state.proposal).not.toHaveBeenCalled()
  })

  it('does not attach a learner note to an unrelated time when its transcript is missing', async () => {
    state.doc = quickNote(999)
    await expect(organizeCourse('source', 'note')).rejects.toThrow(/速记时间/)
    expect(state.structured).not.toHaveBeenCalled()
    expect(state.proposal).not.toHaveBeenCalled()
  })
})

describe('course quiz service', () => {
  it('keeps the last long-cue fragment timestamp intact and validates the returned question', async () => {
    state.segments = [transcript(0, '学习'.repeat(5000))]
    state.structured.mockResolvedValue(quiz())
    await makeCourseQuiz('tab')
    expect(state.structured.mock.calls[0][0].prompt).toMatch(/^\[transcript t=0,30\] /)
    expect(state.structured.mock.calls[0][0].prompt.length).toBeLessThanOrEqual(6000)
  })

  it('rejects a media swap while saving the source, before transmitting old course content', async () => {
    state.courseSource.mockImplementationOnce(async () => {
      state.tab!.media = 'video-2'
      return 'source'
    })
    await expect(makeCourseQuiz('tab')).rejects.toThrow(/变化/)
    expect(state.structured).not.toHaveBeenCalled()
  })

  it.each(['media', 'private', 'sensitive', 'source-excluded', 'transcript'])(
    'rejects a quiz result after %s changes during generation',
    async (change) => {
      state.structured.mockImplementationOnce(async () => {
        if (change === 'media') state.tab!.media = 'video-2'
        if (change === 'private') state.tab!.incognito = true
        if (change === 'sensitive') state.sensitive = true
        if (change === 'source-excluded') state.source.aiExcluded = true
        if (change === 'transcript') state.segments = [transcript(0, '改过的原文')]
        return quiz()
      })
      await expect(makeCourseQuiz('tab')).rejects.toThrow()
      expect(state.proposal).not.toHaveBeenCalled()
    }
  )

  it('expires cached questions after a same-page media swap for both checking and review', async () => {
    state.structured.mockResolvedValue(quiz())
    const question = await makeCourseQuiz('tab')
    state.tab!.media = 'video-2'
    await expect(checkCourseAnswer(question.id, '我的回答')).rejects.toThrow(/变化/)
    expect(() => reviewCourseQuiz(question.id, 'note')).toThrow(/变化/)
    expect(state.structured).toHaveBeenCalledTimes(1)
    expect(state.proposal).not.toHaveBeenCalled()
  })

  it('does not return feedback when the source is excluded during checking', async () => {
    state.structured.mockResolvedValueOnce(quiz())
    const question = await makeCourseQuiz('tab')
    state.structured.mockImplementationOnce(async () => {
      state.source.aiExcluded = true
      return { feedback: '不应交付' }
    })
    await expect(checkCourseAnswer(question.id, '我的回答')).rejects.toThrow(/excluded/)
  })

  it('writes a valid review only through the existing user-requested proposal path', async () => {
    state.structured.mockResolvedValue(quiz())
    const question = await makeCourseQuiz('tab')
    state.note.deletedAt = 1
    expect(() => reviewCourseQuiz(question.id, 'note')).toThrow(/unavailable/)
    expect(state.proposal).not.toHaveBeenCalled()
    state.note.deletedAt = null
    const before = structuredClone(state.doc)
    reviewCourseQuiz(question.id, 'note')
    expect(state.proposal.mock.calls[0][0]).toMatchObject({ noteId: 'note', auto: true, ops: [{ op: 'insert_row' }] })
    expect(state.doc).toEqual(before)
  })
})
