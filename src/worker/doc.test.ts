import { describe, expect, it } from 'vitest'
import { docBlocks, parseDoc } from './doc'
describe('legacy Word structure', () => {
  it('groups tab-delimited rows and paragraphs, without treating clauses as headings', () => {
    expect(docBlocks('第一章 合成\n正文内容。\n\n名称\t数量\n甲\t2\n乙\t3\n\n2.3.2条件：≤20min/件。')).toEqual([
      { type: 'heading', text: '第一章 合成', level: 1 },
      { type: 'paragraph', text: '正文内容。' },
      {
        type: 'table',
        header: ['名称', '数量'],
        rows: [
          ['甲', '2'],
          ['乙', '3']
        ]
      },
      { type: 'paragraph', text: '2.3.2条件：≤20min/件。' }
    ])
  })
  it('returns a Chinese failure for an unreadable legacy file', async () => {
    await expect(parseDoc(joinInvalidPath())).rejects.toThrow('这个 .doc 文件已加密或已损坏，无法读取')
  })
})
function joinInvalidPath(): string {
  return 'missing-test-document.doc'
}
