import { describe, expect, it } from 'vitest'
import { chunkBlocks } from '../chunker'
import { structuredTextBlocks } from '../structuredText'
describe('table content preservation', () => {
  it('retains rowspan keys in later chunks without shifting the parameter column', () => {
    const html = `<table><tr><th>设备</th><th>参数</th></tr><tr><td rowspan="2">设备甲</td><td>${'中文'.repeat(844)}</td></tr><tr><td>后行稀有参数乙</td></tr></table>`
    const chunks = chunkBlocks([{ type: 'table', header: null, rows: [], html }], { locatorOf: () => ({ value: 'block=1' }) })
    const last = chunks.find((c) => c.text.includes('后行稀有参数乙'))!
    expect(last).toBeDefined()
    expect(last.text).toMatch(/设备甲(?:<\/td>\s*<td>|\s*\|\s*)后行稀有参数乙/)
    expect(chunks.every((c) => c.text.length <= 1800)).toBe(true)
  })
  it('preserves same-line prefixes, suffixes and consecutive HTML tables', () => {
    const b = structuredTextBlocks(
      '前文稀有甲<table><tr><th>字段</th></tr><tr><td>值</td></tr></table>中间稀有乙<table><tr><th>第二</th></tr><tr><td>另一值</td></tr></table>后文稀有丙'
    )
    expect(b).toEqual([
      { type: 'paragraph', text: '前文稀有甲' },
      { type: 'table', header: ['字段'], rows: [['值']] },
      { type: 'paragraph', text: '中间稀有乙' },
      { type: 'table', header: ['第二'], rows: [['另一值']] },
      { type: 'paragraph', text: '后文稀有丙' }
    ])
  })
  it('consumes a complete nested table and retains its trailing text', () => {
    const b = structuredTextBlocks(
      '起始<table><tr><th>字段</th></tr><tr><td>外层<table><tr><th>内层</th></tr><tr><td>稀有嵌套</td></tr></table>单元尾</td></tr></table>正文尾'
    )
    expect(b).toHaveLength(3)
    expect(b[0]).toEqual({ type: 'paragraph', text: '起始' })
    expect(b[1]).toMatchObject({ type: 'table', rows: [['外层 内层: 稀有嵌套 单元尾']] })
    expect(b[2]).toEqual({ type: 'paragraph', text: '正文尾' })
  })
  it('keeps a data row identical to a thead row rather than treating it as the header twice', () => {
    const header = '<tr><td>重复行</td><td>值</td></tr>'
    const html = `<table><thead>${header}</thead><tbody>${header}${Array.from({ length: 70 }, (_, i) => `<tr><td>编号${i}</td><td>${'内容'.repeat(20)}</td></tr>`).join('')}</tbody></table>`
    const chunks = chunkBlocks([{ type: 'table', header: null, rows: [], html }], { locatorOf: () => ({ value: 'block=1' }) })
    const count = chunks.reduce((n, c) => n + (c.text.match(/重复行/g)?.length ?? 0), 0)
    expect(count).toBe(chunks.length + 1)
    expect(chunks.map((c) => c.text).join('')).toContain('编号69')
  })
})
