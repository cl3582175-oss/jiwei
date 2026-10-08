import { describe, expect, it } from 'vitest'
import { markdownToNodes } from '../markdown'

describe('markdownToNodes', () => {
  it('converts paragraphs with marks', () => {
    expect(markdownToNodes('一天后遗忘 **66%**，见 [原文](https://a.b)。')).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '一天后遗忘 ' },
          { type: 'text', text: '66%', marks: [{ type: 'bold' }] },
          { type: 'text', text: '，见 ' },
          { type: 'text', text: '原文', marks: [{ type: 'link', attrs: { href: 'https://a.b' } }] },
          { type: 'text', text: '。' }
        ]
      }
    ])
  })

  it('converts headings, lists, code and quotes', () => {
    const nodes = markdownToNodes('#### 小标题\n\n- 甲\n- 乙\n\n1. 一\n\n```js\nx()\n```\n\n> 引用')
    expect(nodes.map((n) => n.type)).toEqual(['heading', 'bulletList', 'orderedList', 'codeBlock', 'blockquote'])
    expect(nodes[0].attrs).toEqual({ level: 3 })
    expect(nodes[1].content?.[1]).toEqual({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '乙' }] }] })
    expect(nodes[3]).toEqual({ type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'x()' }] })
  })

  it('drops unsafe links and never returns an empty array', () => {
    expect(markdownToNodes('[x](javascript:alert(1))')[0].content?.[0]).toEqual({ type: 'text', text: 'x' })
    expect(markdownToNodes('')).toEqual([{ type: 'paragraph' }])
  })

  it('degrades tables to paragraphs', () => {
    const nodes = markdownToNodes('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(nodes.every((n) => n.type === 'paragraph')).toBe(true)
    expect(nodes).toHaveLength(2)
  })
})

describe('nodesToMarkdown', () => {
  it('round-trips common blocks', async () => {
    const { nodesToMarkdown } = await import('../markdown')
    expect(nodesToMarkdown(markdownToNodes('甲段\n\n乙段'))).toBe('甲段\n\n乙段')
    const md = '### 标题\n\n一段 **加粗** 和 [链接](https://a.b)\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n> 引用'
    const back = nodesToMarkdown(markdownToNodes(md))
    expect(back).toBe('### 标题\n\n一段 **加粗** 和 [链接](https://a.b)\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n> 引用')
    expect(markdownToNodes(back).map((n) => n.type)).toEqual(['heading', 'paragraph', 'bulletList', 'orderedList', 'blockquote'])
  })
})
