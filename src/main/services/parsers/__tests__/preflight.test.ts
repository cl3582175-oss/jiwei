import { expect, it } from 'vitest'
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { xlsxFixture } from './fixtures'

it('P0 核对 OOXML 关系、共享与内联字符串、公式缓存的真实结构', async () => {
  const zip = await JSZip.loadAsync(await xlsxFixture())
  const xml = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false })
  const workbook = xml.parse(await zip.file('xl/workbook.xml')!.async('string'))
  expect(workbook.workbook.sheets.sheet.map((s: Record<string, string>) => s['@_name'])).toEqual(['销售', '说明'])
  const shared = xml.parse(await zip.file('xl/sharedStrings.xml')!.async('string'))
  expect(shared.sst.si[0].t).toBe('项目')
  expect(shared.sst.si[1].r.map((r: { t: string }) => r.t).join('')).toBe('甲产品')
  const sheet = xml.parse(await zip.file('xl/worksheets/sheet1.xml')!.async('string'))
  expect(sheet.worksheet.sheetData.row[0].c[1].is.t).toBe('数量')
  expect(sheet.worksheet.sheetData.row[2].c[3]).toMatchObject({ f: 'B2*2', v: '2' })
})
