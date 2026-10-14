import { describe, expect, it } from 'vitest'
import { pdfLayout, linesFromItems, type PdfTextItem } from './pdfLayout'

const item = (str: string, y: number, x = 30, height = 10): PdfTextItem => ({
  str,
  transform: [height, 0, 0, height, x, y],
  height,
  width: str.length * height
})
describe('PDF structure', () => {
  it('clusters by baseline tolerance, orders items by x and uses median height', () => {
    const lines = linesFromItems([item('内容', 100, 50), item('第一', 102, 30), item('下一行', 70)])
    expect(lines.map((l) => l.text)).toEqual(['第一内容', '下一行'])
    expect(lines[0].height).toBe(10)
  })
  it('removes recurring edge furniture and page numbers without removing a matching body line', () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({
      page: i + 1,
      items: [
        item(`合成资料 ${i + 1}`, 790),
        item('引言', 770),
        item('正文开始。', 600),
        item('合成资料 1', 586),
        item('后续正文。', 572),
        item('页脚信息', 40),
        item(`第 ${i + 1} 页`, 20)
      ]
    }))
    const blocks = pdfLayout(pages)
    expect(
      blocks
        .filter((b) => b.type === 'paragraph')
        .map((b) => b.text)
        .join('')
    ).toContain('合成资料 1')
    expect(blocks.map((b) => (b.type === 'table' ? '' : b.text)).join('')).not.toContain('第 2 页')
    expect(blocks).toHaveLength(4)
  })
  it('recognizes font and numbered headings, joins Chinese lines and English hyphenation', () => {
    const blocks = pdfLayout([
      {
        page: 1,
        items: [
          item('2.3加工方法', 760, 30, 15),
          item('中文段落接续', 700),
          item('下一行完整。', 686),
          item('inter-', 600),
          item('national evidence.', 586)
        ]
      }
    ])
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 2, text: '2.3加工方法', page: 1 })
    expect(blocks).toContainEqual({ type: 'paragraph', text: '中文段落接续下一行完整。', page: 1 })
    expect(blocks).toContainEqual({ type: 'paragraph', text: 'international evidence.', page: 1 })
  })
  it('keeps a contents page as one paragraph and ignores TOC heading candidates', () => {
    const blocks = pdfLayout([
      { page: 1, items: Array.from({ length: 6 }, (_, i) => item(`第${i + 1}章 .... ${i + 2}`, 700 - i * 20, 30, i ? 10 : 18)) }
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('paragraph')
    expect(blocks[0]).toMatchObject({ page: 1 })
  })
  it('retains numbered clauses with colon content as body, even in a large font', () => {
    expect(
      pdfLayout([{ page: 1, items: [item('正文'.repeat(30), 600), item('2.3.2生产节拍：≤20min/件。', 500, 30, 18)] }]).every(
        (b) => b.type === 'paragraph'
      )
    ).toBe(true)
  })
})
