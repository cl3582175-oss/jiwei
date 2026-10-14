import { describe, expect, it } from 'vitest'
import { chunkBlocks } from '../chunker'
describe('table content preservation', () => {
  it('keeps a data row identical to a thead row rather than treating it as the header twice', () => {
    const header = '<tr><td>重复行</td><td>值</td></tr>'
    const html = `<table><thead>${header}</thead><tbody>${header}${Array.from({ length: 70 }, (_, i) => `<tr><td>编号${i}</td><td>${'内容'.repeat(20)}</td></tr>`).join('')}</tbody></table>`
    const chunks = chunkBlocks([{ type: 'table', header: null, rows: [], html }], { locatorOf: () => ({ value: 'block=1' }) })
    const count = chunks.reduce((n, c) => n + (c.text.match(/重复行/g)?.length ?? 0), 0)
    expect(count).toBe(chunks.length + 1)
    expect(chunks.map((c) => c.text).join('')).toContain('编号69')
  })
})
