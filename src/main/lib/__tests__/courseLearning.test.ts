import { describe, expect, it } from 'vitest'
import type { CourseSegment } from '@shared/course'
import type { DocJSON, DocNode } from '@shared/types'
import { chunkCourseEvidence, courseEvidencePresent, courseNodeText, courseQuickNotes, preserveCourseNotes } from '../courseLearning'

const transcript = (start: number, text: string, end = start + 10): CourseSegment => ({
  kind: 'transcript',
  locator: { value: `t=${start},${end}` },
  text
})
const paragraph = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content })
const text = (value: string): DocNode => ({ type: 'text', text: value })
const timeLink = (href: string): DocNode => ({ ...text('▶ 0:20'), marks: [{ type: 'link', attrs: { href } }] })

describe('course evidence chunks', () => {
  it('keeps the timestamp with a segment crossing the 6000-character boundary', () => {
    const first = transcript(0, '甲'.repeat(5965))
    const second = transcript(20, '完整的下一段')
    const chunks = chunkCourseEvidence([first, second])
    expect(chunks).toHaveLength(2)
    expect(chunks[0].segments).toEqual([first])
    expect(chunks[1]).toEqual({ text: '[transcript t=20,30] 完整的下一段', segments: [second] })
    expect(chunks.every((c) => c.text.length <= 6000)).toBe(true)
  })

  it('repeats the complete timestamp for every fragment of a long cue without losing text or Unicode', () => {
    const original = '学习🧠'.repeat(4000)
    const segment = transcript(120.5, original, 180)
    const marker = '[transcript t=120.5,180] '
    const chunks = chunkCourseEvidence([segment])
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every((c) => c.text.length <= 6000 && c.text.startsWith(marker))).toBe(true)
    expect(chunks.map((c) => c.text.slice(marker.length)).join('')).toBe(original)
    expect(chunks.every((c) => !/[\uD800-\uDBFF]$/.test(c.text))).toBe(true)
    expect(chunks.every((c) => c.segments[0] === segment)).toBe(true)
  })

  it('keeps a recent quiz suffix at a complete evidence boundary and excludes malformed evidence', () => {
    const last = transcript(100, '最近的课堂内容')
    const chunks = chunkCourseEvidence([
      transcript(0, '旧材料'.repeat(3000)),
      { kind: 'transcript', locator: { value: 't=undefined' }, text: '没有合法时间' },
      { kind: 'paragraph', locator: { value: 't=1,2' }, text: '网页正文' },
      last
    ])
    expect(chunks.at(-1)?.text).toContain('[transcript t=100,110] 最近的课堂内容')
    expect(chunks.map((c) => c.text).join('')).not.toContain('没有合法时间')
    expect(chunks.map((c) => c.text).join('')).not.toContain('网页正文')
    expect(() => chunkCourseEvidence([last], 20)).toThrow()
  })
})

describe('course evidence revalidation', () => {
  it('allows appended material and regenerated database ids but rejects changed text, time and media', () => {
    const before = [transcript(0, '原文'), { kind: 'slide', locator: { value: 't=1', image: 'asset-1' }, text: '幻灯片' }]
    expect(courseEvidencePresent(before, [...before.map((s) => ({ ...s, id: 'new-id' })), transcript(20, '后来追加')])).toBe(true)
    expect(courseEvidencePresent(before, [transcript(0, '已经更正'), before[1]])).toBe(false)
    expect(courseEvidencePresent(before, [transcript(2, '原文'), before[1]])).toBe(false)
    expect(courseEvidencePresent(before, [before[0], { ...before[1], locator: { value: 't=1', image: 'asset-2' } }])).toBe(false)
    expect(courseEvidencePresent(before, [])).toBe(false)
  })
})

describe('course learner wording', () => {
  it('reads linked Cornell rows with their first valid timestamp and keeps literal text and line breaks', () => {
    const doc: DocJSON = {
      type: 'doc',
      content: [
        {
          type: 'cornellRow',
          attrs: { id: 'row-1' },
          content: [
            { type: 'cornellCue', content: [paragraph(text('我的问题'))] },
            {
              type: 'cornellBody',
              content: [
                paragraph(
                  timeLink('jiwei://source/course?t=20'),
                  text(' **原话** &amp; <原文>'),
                  { type: 'hardBreak' },
                  text('下一行'),
                  timeLink('jiwei://source/course?t=30')
                )
              ]
            }
          ]
        }
      ]
    }
    const snapshot = structuredClone(doc)
    expect(courseQuickNotes(doc, 'course')).toEqual([
      { rowId: 'row-1', t: 20, text: '我的问题\n▶ 0:20 **原话** &amp; <原文>\n下一行▶ 0:20' }
    ])
    expect(doc).toEqual(snapshot)
  })

  it('does not treat malformed, negative, empty, foreign or lookalike links as course evidence', () => {
    const invalid = [
      'not a URL',
      'jiwei://source/course?t=-1',
      'jiwei://source/course?t=',
      'jiwei://source/course?t=Infinity',
      'jiwei://source/course2?t=20',
      'https://source/course?t=20'
    ]
    const doc: DocJSON = {
      type: 'doc',
      content: invalid.map((href) => ({ type: 'cornellRow', content: [paragraph(timeLink(href), text('原话'))] }))
    }
    expect(courseQuickNotes(doc, 'course')).toEqual([])
  })

  it('keeps meaningful leading and trailing spaces in quoted code or learner wording', () => {
    const doc: DocJSON = {
      type: 'doc',
      content: [{ type: 'cornellRow', content: [paragraph(text('  保留缩进 '), timeLink('jiwei://source/course?t=20'), text('  '))] }]
    }
    const [note] = courseQuickNotes(doc, 'course')
    expect(note.text).toBe('  保留缩进 ▶ 0:20  ')
    const [row] = preserveCourseNotes([{ t: 20, body: '课程要点' }], [note])
    expect(courseNodeText({ content: row.bodyNodes })).toContain(note.text)
  })

  it('preserves metacharacters as literal proposal nodes without changing the original model rows', () => {
    const rows = [
      { t: 10, body: '**要点**' },
      { t: 100, body: '后面的要点' }
    ]
    const snapshot = structuredClone(rows)
    const raw = '**原话** &amp; <必须保留>\n第二行'
    const result = preserveCourseNotes(rows, [{ rowId: 'row', t: 98, text: raw }])
    expect(courseNodeText({ content: result[1].bodyNodes })).toContain(raw)
    expect(result[1].bodyNodes.slice(1)).toEqual([paragraph(text('**原话** &amp; <必须保留>')), paragraph(text('第二行'))])
    expect(rows).toEqual(snapshot)
    expect(result[0].bodyNodes).toEqual([paragraph({ type: 'text', text: '要点', marks: [{ type: 'bold' }] })])
  })

  it('checks rendered wording rather than Markdown source and does not duplicate already preserved wording', () => {
    const note = { rowId: 'row', t: 0, text: '**必须保留星号**' }
    const parsedAway = preserveCourseNotes([{ t: 0, body: note.text }], [note])
    expect(courseNodeText({ content: parsedAway[0].bodyNodes })).toContain(note.text)
    const exact = preserveCourseNotes([{ t: 0, body: '\\*\\*必须保留星号\\*\\*' }], [note])
    expect(exact[0].bodyNodes).toHaveLength(1)
    expect(preserveCourseNotes([], [note])).toEqual([])
  })
})
