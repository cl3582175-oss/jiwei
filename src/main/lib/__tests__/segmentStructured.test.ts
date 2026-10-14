import { describe, expect, it } from 'vitest'
import { segmentTextStructured } from '../segment'
describe('structured text segmentation', () => {
  it('keeps numbered plain text headings and clauses with body content distinct', () => {
    const chunks = segmentTextStructured('第一章 合成\n2.3处理方法\n正文。\n2.3.2条件：≤20min/件。', 'plain')
    expect(chunks).toHaveLength(1)
    expect(chunks[0].heading).toBe('第一章 合成 › 2.3处理方法')
    expect(chunks[0].text).toContain('2.3.2条件：≤20min/件。')
  })
  it('keeps long Markdown tables intact through the old segmentText length boundary', () => {
    const rows = Array.from({ length: 90 }, (_, i) => `| 唯一行${i} | ${'内容'.repeat(18)} |`)
    const text = ['# 合成', '| 名称 | 说明 |', '| --- | --- |', ...rows].join('\n')
    const chunks = segmentTextStructured(text, 'markdown')
    expect(chunks.every((c) => c.kind === 'table' && c.text.includes('| 名称 | 说明 |'))).toBe(true)
    for (const row of rows) expect(chunks.map((c) => c.text).join('\n')).toContain(row)
  })
  it('keeps code whitespace and the source selector while merging ordinary paragraphs', () => {
    const chunks = segmentTextStructured('# 条件\n\n正文一。\n\n正文二。\n\n```ts\nconst  x = 2\n```', 'markdown')
    expect(chunks[0].text).toBe('正文一。\n\n正文二。')
    expect(chunks[0].locator).toMatchObject({ type: 'TextPositionSelector', start: 6 })
    expect(chunks[1].kind).toBe('code')
    expect(chunks[1].text).toContain('const  x = 2')
  })
})
