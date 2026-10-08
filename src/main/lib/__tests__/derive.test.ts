import { describe, expect, it } from 'vitest'
import { countWords, deriveDoc, diffBlocks } from '../derive'
import type { DocJSON, DocNode } from '@shared/types'

const p = (id: string, text: string): DocNode => ({ type: 'paragraph', attrs: { id }, content: text ? [{ type: 'text', text }] : [] })
const row = (id: string, cue: DocNode[], body: DocNode[]): DocNode => ({
  type: 'cornellRow',
  attrs: { id },
  content: [
    { type: 'cornellCue', content: cue },
    { type: 'cornellBody', content: body }
  ]
})
const doc = (...content: DocNode[]): DocJSON => ({ type: 'doc', content })
const summary = (id: string, ...content: DocNode[]): DocNode => ({ type: 'cornellSummary', attrs: { id }, content })

describe('deriveDoc', () => {
  const d = deriveDoc(
    doc(
      row('r1', [p('c1', '什么是费曼学习法？')], [p('b1', '用简单的语言解释概念。'), p('b2', '讲不清楚说明没理解。')]),
      row('r2', [p('c2', '')], [p('b3', '')]),
      summary('s1', p('s1p', '以教促学。'))
    )
  )

  it('produces a row block combining cue and body', () => {
    const r1 = d.blocks.find((b) => b.id === 'r1')!
    expect(r1.section).toBe('row')
    expect(r1.text).toBe('什么是费曼学习法？\n用简单的语言解释概念。\n讲不清楚说明没理解。')
  })

  it('produces paragraph blocks bound to their row', () => {
    const b1 = d.blocks.find((b) => b.id === 'b1')!
    expect(b1).toMatchObject({ section: 'body', rowId: 'r1', kind: 'paragraph' })
    expect(d.blocks.find((b) => b.id === 'c1')).toMatchObject({ section: 'cue', rowId: 'r1' })
    expect(d.blocks.find((b) => b.id === 's1p')).toMatchObject({ section: 'summary', rowId: null })
  })

  it('skips empty rows and paragraphs', () => {
    expect(d.blocks.some((b) => ['r2', 'c2', 'b3'].includes(b.id))).toBe(false)
  })

  it('keeps document order in positions', () => {
    const ids = d.blocks.map((b) => b.id)
    expect(ids.indexOf('r1')).toBeLessThan(ids.indexOf('c1'))
    expect(ids.indexOf('b2')).toBeLessThan(ids.indexOf('s1p'))
  })

  it('builds plain text in reading order', () => {
    expect(d.plainText).toBe('什么是费曼学习法？\n用简单的语言解释概念。\n讲不清楚说明没理解。\n以教促学。')
  })

  it('collects asset references and internal links', () => {
    const sha = 'a'.repeat(64)
    const noteId = '0190e2c4-7b3a-7c3e-9a1b-2b3c4d5e6f70'
    const r = deriveDoc(
      doc(
        row('r', [p('c', '')], [
          { type: 'image', attrs: { id: 'i', src: `jiwei://asset/${sha}.png` } },
          { type: 'paragraph', attrs: { id: 'l' }, content: [{ type: 'text', text: '见', marks: [{ type: 'link', attrs: { href: `jiwei://note/${noteId}` } }] }] }
        ]),
        summary('s', p('sp', ''))
      )
    )
    expect(r.assetIds).toEqual([sha])
    expect(r.links).toEqual([{ toType: 'note', toId: noteId, fromBlockId: 'l' }])
  })
})

describe('diffBlocks', () => {
  const next = deriveDoc(doc(row('r1', [p('c1', 'Q')], [p('b1', 'A2')]), summary('s', p('sp', '')))).blocks
  const prevHash = (id: string): string => deriveDoc(doc(row('r1', [p('c1', 'Q')], [p('b1', 'A1')]), summary('s', p('sp', '')))).blocks.find((b) => b.id === id)!.hash

  it('detects changed, unchanged, new, removed and revived blocks', () => {
    const diff = diffBlocks(
      [
        { id: 'c1', hash: prevHash('c1'), deletedAt: null },
        { id: 'b1', hash: prevHash('b1'), deletedAt: null },
        { id: 'gone', hash: 'x', deletedAt: null },
        { id: 'r1', hash: 'old', deletedAt: 123 }
      ],
      next
    )
    expect(diff.moved.map((b) => b.id)).toEqual(['c1'])
    expect(diff.changed.map((b) => b.id)).toEqual(['b1'])
    expect(diff.revived.map((b) => b.id)).toEqual(['r1'])
    expect(diff.removedIds).toEqual(['gone'])
    expect(diff.inserted).toEqual([])
  })
})

describe('countWords', () => {
  it('counts CJK characters and latin words', () => {
    expect(countWords('学习 Feynman technique 方法')).toBe(6)
  })
})

describe('embeds and origin', () => {
  const ai = JSON.stringify({ by: 'ai', model: 'test', at: 1 })
  const aiReviewed = JSON.stringify({ by: 'ai', at: 1, reviewed: true })
  const mindmap = {
    kind: 'mindmap',
    data: {
      root: 'm0',
      nodes: {
        m0: { text: '学习方法', parent: null, order: 0 },
        m1: { text: '费曼', parent: 'm0', order: 0 },
        m2: { text: '间隔重复', parent: 'm0', order: 1 }
      }
    }
  }
  const d = deriveDoc(
    doc(
      row('r1', [p('c1', '问题')], [
        { type: 'embed', attrs: { id: 'e1', kind: 'mindmap', origin: ai } },
        { type: 'paragraph', attrs: { id: 'b1', origin: aiReviewed }, content: [{ type: 'text', text: '审阅过' }] },
        p('b2', '我写的')
      ]),
      summary('s', p('sp', ''))
    ),
    { e1: mindmap }
  )

  it('turns embed data into searchable outline text', () => {
    expect(d.blocks.find((b) => b.id === 'e1')).toMatchObject({ kind: 'embed', origin: 'ai', text: '学习方法\n  费曼\n  间隔重复' })
    expect(d.plainText).toContain('间隔重复')
  })

  it('tracks block origin and unreviewed AI text', () => {
    expect(d.blocks.find((b) => b.id === 'b1')!.origin).toBe('ai_reviewed')
    expect(d.blocks.find((b) => b.id === 'b2')!.origin).toBe('user')
    expect(d.aiText).toBe('学习方法\n  费曼\n  间隔重复')
  })
})
