import JSZip from 'jszip'

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

/** Excel 的 OOXML 保存结构：关系定位工作表，字符串表/内联字符串和公式缓存并存。 */
export async function xlsxFixture(rows = 4): Promise<Buffer> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'
  )
  zip.file(
    'xl/workbook.xml',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="销售" sheetId="1" r:id="rId2"/><sheet name="说明" sheetId="2" r:id="rId1"/></sheets></workbook>'
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Target="worksheets/sheet1.xml"/><Relationship Id="rId1" Target="worksheets/sheet2.xml"/></Relationships>'
  )
  zip.file(
    'xl/sharedStrings.xml',
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>项目</t></si><si><r><t>甲</t></r><r><t>产品</t></r></si></sst>'
  )
  const body = Array.from(
    { length: rows },
    (_, i) =>
      `<row r="${i + 2}"><c r="A${i + 2}" t="s"><v>1</v></c><c r="B${i + 2}"><v>${i + 1}</v></c><c r="C${i + 2}" t="b"><v>${i % 2}</v></c><c r="D${i + 2}"><f>B${i + 2}*2</f><v>${(i + 1) * 2}</v></c></row>`
  ).join('')
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>数量</t></is></c><c r="C1" t="inlineStr"><is><t>有效</t></is></c><c r="D1" t="inlineStr"><is><t>合计</t></is></c></row><row r="99"/>${body}</sheetData></worksheet>`
  )
  zip.file(
    'xl/worksheets/sheet2.xml',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>说明</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>现场生成</t></is></c></row></sheetData></worksheet>'
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

export async function pptxFixture(pages = 3): Promise<Buffer> {
  const zip = new JSZip()
  for (let i = 1; i <= pages; i++) {
    zip.file(
      `ppt/slides/slide${i}.xml`,
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${escape(`标题 ${i}`)}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:r><a:t>正文 ${i}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
    )
    zip.file(
      `ppt/slides/_rels/slide${i}.xml.rels`,
      `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${pages + 1 - i}.xml"/></Relationships>`
    )
    zip.file(
      `ppt/notesSlides/notesSlide${pages + 1 - i}.xml`,
      `<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>备注 ${i}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`
    )
  }
  return zip.generateAsync({ type: 'nodebuffer' })
}
