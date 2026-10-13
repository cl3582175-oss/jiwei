import { describe, expect, it } from 'vitest'
import { snapshotParagraphs } from './snapshot'

describe('web snapshot paragraphs', () => {
  it('keeps the exact UTF-16 offsets and text of every paragraph', () => {
    const text = '🙂开头\n还有一行\n\n中间 🧭 文字\n\n结尾'
    const start = text.indexOf('中间'),
      end = text.indexOf('\n\n结尾')
    const paragraphs = snapshotParagraphs(text, `chars=${start}-${end}`)
    expect(paragraphs.map((p) => p.text)).toEqual(['🙂开头\n还有一行', '中间 🧭 文字', '结尾'])
    for (const paragraph of paragraphs) expect(text.slice(paragraph.start, paragraph.end)).toBe(paragraph.text)
    expect(paragraphs.filter((p) => p.highlighted)).toEqual([{ text: '中间 🧭 文字', start, end, highlighted: true }])
    expect(paragraphs[0].end).toBe('🙂开头\n还有一行'.length)
  })

  it('highlights each paragraph that overlaps a half-open reference range', () => {
    const text = '第一段\n\n第二段\n\n第三段'
    expect(snapshotParagraphs(text, 'chars=2-6').map((p) => p.highlighted)).toEqual([true, true, false])
    expect(snapshotParagraphs(text, 'chars=5-8').map((p) => p.highlighted)).toEqual([false, true, false])
    expect(snapshotParagraphs(text, 'chars=3-5').map((p) => p.highlighted)).toEqual([false, false, false])
  })

  it('does not shift offsets when skipping leading, repeated, or trailing blank lines', () => {
    const text = '\n\n  第一段  \r\n \t\r\n\r\n第二段\r\n\r\n'
    const start = text.indexOf('第二段')
    const paragraphs = snapshotParagraphs(text, `chars=${start}-${start + 3}`)
    expect(paragraphs.map((p) => p.text)).toEqual(['  第一段  ', '第二段'])
    expect(paragraphs[0]).toMatchObject({ start: 2, end: 9, highlighted: false })
    expect(paragraphs[1]).toMatchObject({ start, end: start + 3, highlighted: true })
    for (const paragraph of paragraphs) expect(text.slice(paragraph.start, paragraph.end)).toBe(paragraph.text)
  })

  it('preserves literal HTML as text without interpreting or decoding it', () => {
    const text = '<img src=x onerror="window.attack=1"> &lt;script&gt;\n\n& 中文'
    const paragraphs = snapshotParagraphs(text, `chars=0-${text.indexOf('\n\n')}`)
    expect(paragraphs[0].text).toBe('<img src=x onerror="window.attack=1"> &lt;script&gt;')
    expect(paragraphs[1].text).toBe('& 中文')
  })

  it.each([null, '', 'page=1', 'chars=3-3', 'chars=4-2', 'chars=-1-3', 'chars=0-100', 'chars=0-9007199254740992', 'chars=0-3 extra'])(
    'does not highlight an invalid locator %j',
    (locator) => {
      expect(snapshotParagraphs('第一段\n\n第二段', locator).some((p) => p.highlighted)).toBe(false)
    }
  )

  it('handles empty snapshots and an unseparated paragraph', () => {
    expect(snapshotParagraphs('', null)).toEqual([])
    expect(snapshotParagraphs('\n\n \t\n\n', null)).toEqual([])
    expect(snapshotParagraphs('完整正文', 'chars=0-4')).toEqual([{ text: '完整正文', start: 0, end: 4, highlighted: true }])
  })
})
