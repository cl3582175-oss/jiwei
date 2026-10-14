import { describe, expect, it } from 'vitest'
import { mergeRecognizedStructured, htmlTableToMarkdown, pageLocator } from '../recognized'
import { classifyPageNeeds } from '../../../worker/pdfTriage'
describe('structured recognition', () => {
  it('retains the part/chapter/section hierarchy when a scan continues on the next page', () => {
    const chunks = mergeRecognizedStructured(
      [],
      [
        { page: 1, need: 'scan', text: '第一编 合成\n第一章 条件\n第一节 范围\n正文内容。' },
        { page: 2, need: 'scan', text: '接续内容。' }
      ]
    )
    expect(chunks.map((c) => c.heading)).toEqual(['第一编 合成 › 第一章 条件 › 第一节 范围', '第一编 合成 › 第一章 条件 › 第一节 范围'])
  })
  it('handles an empty table without throwing or fabricating content', () => {
    expect(htmlTableToMarkdown('<table><tr><td></td></tr></table>')).toBe('')
  })
  it('preserves a multi-digit merged-cell span as safe HTML', () => {
    const text = htmlTableToMarkdown('<table><tr><td colspan="12" onclick="bad()">完整内容</td></tr></table>')
    expect(text).toContain('colspan="12"')
    expect(text).not.toContain('onclick')
  })
  it('allows table and figure together while scanning stays exclusive', () => {
    const s = { chars: 300, lines: ['表1 数据', '图1 流程'], imageCover: 0.4, paths: 0 }
    expect(classifyPageNeeds(s)).toEqual(['table', 'figure'])
    expect(classifyPageNeeds({ ...s, chars: 0, imageCover: 1 })).toEqual(['scan'])
    expect(classifyPageNeeds({ ...s, lines: [], imageCover: 0 })).toEqual([])
  })
  it('carries heading paths through consecutive scan pages and keeps figure descriptions whole', () => {
    const merged = mergeRecognizedStructured(
      [],
      [
        { page: 2, need: 'scan', text: '第二页内容。'.repeat(50) },
        { page: 1, need: 'scan', text: '# 第一章 合成\n## 第一节 细节\n⼈需要证据。'.repeat(1) + '\n' + '正文内容。'.repeat(70) },
        { page: 3, need: 'figure', text: '复杂图解。'.repeat(400) }
      ]
    )
    expect(merged[0]).toMatchObject({ kind: 'ocr:scan', heading: '第一章 合成 › 第一节 细节', locator: pageLocator(1) })
    expect(merged.find((c) => c.locator.value === 'page=2')?.heading).toBe('第一章 合成 › 第一节 细节')
    expect(merged.map((c) => c.text).join('')).not.toContain('⼈')
    expect(merged.filter((c) => c.kind === 'ocr:figure')).toHaveLength(1)
  })
  it('chunks Markdown table rows with headers, and can resume a caller supplied heading stack', () => {
    const table = ['| 名称 | 说明 |', '| --- | --- |', ...Array.from({ length: 40 }, (_, i) => `| ${i} | ${'内容'.repeat(20)} |`)].join(
      '\n'
    )
    const merged = mergeRecognizedStructured(
      [],
      [{ page: 4, need: 'table', text: table }],
      [{ type: 'heading', level: 1, text: '上页章节' }]
    )
    expect(merged.length).toBeGreaterThan(1)
    for (const c of merged) {
      expect(c.heading).toBe('上页章节')
      expect(c.text).toContain('| 名称 | 说明 |')
      expect(c.text.length).toBeLessThanOrEqual(1800)
    }
    expect(merged.map((c) => c.text).join('')).toContain('| 39 |')
  })
})
