import { describe, expect, it } from 'vitest'
import { convertNotion, parseCsv, stripNotionId } from '../../services/importer/notion'
describe('Notion Markdown and CSV conversion', () => {
  it('strips only trailing filename IDs and keeps ordinary text', () => {
    expect(stripNotionId('中文页面 0123456789abcdef0123456789ABCDEF.md')).toBe('中文页面.md')
    expect(stripNotionId('中文分类 0123456789abcdef0123456789abcdef')).toBe('中文分类')
    expect(stripNotionId('包含1234的普通名.md')).toBe('包含1234的普通名.md')
    expect(convertNotion('', '中文页面 0123456789abcdef0123456789abcdef.md', []).title).toBe('中文页面')
  })
  it('parses commas, line breaks, quotes, BOM, empty cells and CRLF', () => {
    expect(parseCsv('\uFEFF名称,备注,状态\r\n"晨读","逗号,与\n换行和""引号""",\r\n')).toEqual([
      ['名称', '备注', '状态'],
      ['晨读', '逗号,与\n换行和"引号"', '']
    ])
    expect(() => parseCsv('a,b\n"unterminated')).toThrow()
    expect(() => parseCsv('a,b\n"x"illegal,y')).toThrow()
  })
  it('builds a native table, caps columns at twelve and links database entry pages', () => {
    const id = '0123456789abcdef0123456789abcdef'
    const pages = [`数据库 ${id}/晨读 22222222222222222222222222222222.md`, `其他/晨读 33333333333333333333333333333333.md`]
    const r = convertNotion(
      Array.from({ length: 14 }, (_, i) => `列${i}`).join(',') + '\n晨读,"含,逗号",x,x,x,x,x,x,x,x,x,x,x,x',
      `数据库 ${id}.csv`,
      pages
    )
    expect(r.title).toBe('数据库')
    expect(r.issues).toContain('extra-columns')
    const table = r.doc.content![0].content![1].content![0]
    expect(table.type).toBe('table')
    expect(table.content![0].content).toHaveLength(12)
    expect(r.refs).toHaveLength(1)
    expect(decodeURIComponent(r.refs[0].target)).toBe(pages[0])
    expect(JSON.stringify(table.content![1])).toContain('jiwei://import/0')
  })
  it('reports ambiguous database row names and encodes literal hash characters in page paths', () => {
    const id = '11111111111111111111111111111111'
    const path = `库 ${id}.csv`
    const r = convertNotion('名称\nC#\n同名', path, [
      `库 ${id}/C# 22222222222222222222222222222222.md`,
      `库 ${id}/同名 33333333333333333333333333333333.md`,
      `库 ${id}/同名 44444444444444444444444444444444.md`
    ])
    expect(r.refs[0].target).toContain('C%23')
    expect(r.issues).toContain('ambiguous')
    expect(r.refs).toHaveLength(1)
  })
  it('keeps URL-encoded Notion page paths resolvable through the existing matching pipeline', () => {
    const r = convertNotion(
      '[子页](%E5%AD%90%E9%A1%B5%2022222222222222222222222222222222.md)',
      '入口 11111111111111111111111111111111.md',
      []
    )
    expect(r.refs[0]).toMatchObject({ kind: 'note', target: '%E5%AD%90%E9%A1%B5%2022222222222222222222222222222222.md', wiki: false })
  })
})
