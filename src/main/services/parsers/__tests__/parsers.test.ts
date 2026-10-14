import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { xlsxFixture, pptxFixture } from './fixtures'

const dirs: string[] = []
async function file(name: string, data: string | Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jiwei-attachment-parser-'))
  dirs.push(dir)
  const path = join(dir, name)
  await writeFile(path, data)
  return path
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

it('xlsx 关系按工作表名取两表，保留共享/内联/数字/布尔/公式缓存并跳空行', async () => {
  const { parseXlsx } = await import('../xlsx')
  const result = await parseXlsx(await file('two.xlsx', await xlsxFixture()))
  expect(result).toHaveLength(2)
  expect(result[0].text).toContain('## 销售\n| 项目 | 数量 | 有效 | 合计 |')
  expect(result[0].text).toContain('| 甲产品 | 1 | FALSE | 2 |')
  expect(result[0].text).toContain('| 甲产品 | 2 | TRUE | 4 |')
  expect(result[1].text).toContain('## 说明')
  expect(result[1].text).toContain('现场生成')
})

it('xlsx 120数据行按50行切段并重复表头，定位含工作表和实际行号', async () => {
  const { parseXlsx } = await import('../xlsx')
  const result = await parseXlsx(await file('rows.xlsx', await xlsxFixture(120)))
  const parts = result.filter((s) => s.locator.sheet === '销售')
  expect(parts).toHaveLength(3)
  expect(parts.map((s) => [s.locator.rowStart, s.locator.rowEnd])).toEqual([
    [2, 51],
    [52, 101],
    [102, 121]
  ])
  expect(parts.every((s) => s.text.includes('| 项目 | 数量 | 有效 | 合计 |'))).toBe(true)
})

it('xlsx 缺失单元格按列位置补空、保留日期序号和公式字符串缓存、空表不造段', async () => {
  const { parseXlsx } = await import('../xlsx')
  const zip = await JSZip.loadAsync(await xlsxFixture())
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>A</t></is></c><c r="C1" t="inlineStr"><is><t>C</t></is></c></row><row r="2"><c r="A2"><v>45000</v></c><c r="C2" t="str"><f>TEXT(A2)</f><v>a|b</v></c></row></sheetData></worksheet>'
  )
  zip.file('xl/worksheets/sheet2.xml', '<worksheet><sheetData/></worksheet>')
  const result = await parseXlsx(await file('sparse.xlsx', await zip.generateAsync({ type: 'nodebuffer' })))
  expect(result).toHaveLength(1)
  expect(result[0].text).toContain('| 45000 |  | a\\|b |')
})

it.each([
  ['comma', '"名称","备注"\r\n"甲,乙","他说""好"""\r\n"丙","第一行\n第二行"', '| 甲,乙 | 他说"好" |'],
  ['semicolon', '名称;数量\n甲;2', '| 甲 | 2 |'],
  ['tab', '\ufeff名称\t数量\n甲\t3', '| 甲 | 3 |']
])('csv RFC4180 %s 分隔、转义引号、引号内换行和 BOM', async (_, raw, expected) => {
  const { parseCsv } = await import('../csv')
  const result = await parseCsv(await file('sample.csv', raw))
  expect(result[0].text).toContain(expected)
  if (raw.includes('第一行')) expect(result[0].text).toContain('第一行<br>第二行')
})

it('csv 按50行分段；未闭合引号如实失败', async () => {
  const { parseCsv } = await import('../csv')
  const raw = 'name,value\n' + Array.from({ length: 120 }, (_, i) => `item${i},${i}`).join('\n')
  const result = await parseCsv(await file('large.csv', raw))
  expect(result).toHaveLength(3)
  expect(result.every((s) => s.text.includes('| name | value |'))).toBe(true)
  await expect(parseCsv(await file('broken.csv', 'a,b\n"unclosed,b'))).rejects.toThrow()
})

it('csv 非UTF8时尝试GBK，保留可解码内容', async () => {
  const { parseCsv } = await import('../csv')
  const raw = new Uint8Array([0xc3, 0xfb, 0xb3, 0xc6, 44, 118, 97, 108, 117, 101, 10, 0xbc, 0xd7, 44, 50])
  const result = await parseCsv(await file('gbk.csv', raw))
  expect(result[0].text).toContain('| 名称 | value |')
  expect(result[0].text).toContain('| 甲 | 2 |')
})

it('OOXML 文档不展开 DTD/实体且拒绝越出包根的关系', async () => {
  const { parseXlsx } = await import('../xlsx')
  const zip = await JSZip.loadAsync(await xlsxFixture())
  zip.file('xl/sharedStrings.xml', '<!DOCTYPE sst [<!ENTITY secret "payload">]><sst><si><t>&secret;</t></si></sst>')
  await expect(parseXlsx(await file('entity.xlsx', await zip.generateAsync({ type: 'nodebuffer' })))).rejects.toThrow('XML')
  const { relationshipPath } = await import('../ooxml')
  expect(() => relationshipPath('xl/workbook.xml', '../../../secret.xml')).toThrow('relationship')
})

it('pptx 3页正文及备注按关系对应，定位可跳页', async () => {
  const { parsePptx } = await import('../pptx')
  const result = await parsePptx(await file('three.pptx', await pptxFixture()))
  expect(result.map((s) => s.locator.page)).toEqual([1, 2, 3])
  expect(result[1].text).toContain('第 2 页')
  expect(result[1].text).toContain('标题 2')
  expect(result[1].text).toContain('正文 2')
  expect(result[1].text).toContain('讲者备注：备注 2')
  expect(result[1].locator.value).toBe('page=2')
})

it('pptx 数字排序让 slide10 位于 slide9 后，不能词典序', async () => {
  const { parsePptx } = await import('../pptx')
  const result = await parsePptx(await file('ten.pptx', await pptxFixture(10)))
  expect(result[8].text).toContain('标题 9')
  expect(result[9].text).toContain('标题 10')
})

it('代码每120行一段保留缩进，语言围栏与行定位不丢失', async () => {
  const { parseCode } = await import('../code')
  const raw = Array.from({ length: 241 }, (_, i) => `    const n${i} = ${i}`).join('\n')
  const result = await parseCode(await file('sample.ts', raw), 'ts')
  expect(result).toHaveLength(3)
  expect(result[0].text).toContain('```typescript\n    const n0 = 0')
  expect(result[1].text).toContain('    const n120 = 120')
  expect(result[2].locator).toMatchObject({ lineStart: 241, lineEnd: 241 })
})
