import { describe, expect, it } from 'vitest'
import { fromNested, toCornellRows, toMarkdown, toText, toTree } from '@shared/embeds/mindmap'
import { segmentText } from '../segment'

let n = 0
const data = fromNested(
  { text: '康奈尔笔记', children: [{ text: '线索栏', children: [{ text: '问题' }, { text: '关键词' }] }, { text: '总结栏' }] },
  () => `n${n++}`
)

describe('mindmap', () => {
  it('round-trips nested → flat → tree', () => {
    expect(toTree(data)!.children.map((c) => c.text)).toEqual(['线索栏', '总结栏'])
  })
  it('renders outline text and markdown', () => {
    expect(toText(data)).toBe('康奈尔笔记\n  线索栏\n    问题\n    关键词\n  总结栏')
    expect(toMarkdown(data)).toBe('# 康奈尔笔记\n## 线索栏\n### 问题\n### 关键词\n## 总结栏')
  })
  it('converts first-level branches into Cornell rows', () => {
    const rows = toCornellRows(data)
    expect(rows).toHaveLength(2)
    expect(JSON.stringify(rows[0].cue)).toContain('线索栏')
    expect(JSON.stringify(rows[0].body)).toContain('bulletList')
  })
  it('survives cycles in malformed data', () => {
    expect(
      toTree({ root: 'a', nodes: { a: { text: 'a', parent: 'b', order: 0 }, b: { text: 'b', parent: 'a', order: 0 } } })!.children[0]
        .children
    ).toEqual([])
  })
})

describe('segmentText', () => {
  it('splits markdown into headings, paragraphs and code with stable offsets', () => {
    const md = '# 标题\n\n第一段\n继续\n\n```js\ncode\n```\n\n第二段'
    const segs = segmentText(md, 'markdown')
    expect(segs.map((s) => s.kind)).toEqual(['heading', 'paragraph', 'code', 'paragraph'])
    for (const s of segs) expect(md.slice(s.locator.start, s.locator.end).trim()).toBe(s.text)
  })
})
