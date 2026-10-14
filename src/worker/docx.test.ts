import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseDocx } from './docx'

describe('structured Word document', () => {
  it('parses an actual generated docx with styles, numbered headings, lists and merged cells', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rag-word-'))
    try {
      const zip = new JSZip()
      zip.file(
        '[Content_Types].xml',
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
      )
      zip.file(
        '_rels/.rels',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
      )
      zip.file(
        'word/_rels/document.xml.rels',
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="n" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>'
      )
      zip.file(
        'word/styles.xml',
        '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>'
      )
      zip.file(
        'word/numbering.xml',
        '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'
      )
      const p = (s: string, prop = '') => `<w:p>${prop}<w:r><w:t>${s}</w:t></w:r></w:p>`
      zip.file(
        'word/document.xml',
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${p('第一章 合成', '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>')}${p('2.3验证方法')}${p('完整正文重复。'.repeat(55))}${p('2.3.2条件：≤20min/件。')}${p('清单事项', '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>')}${p('表1 合成数据')}<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${p('类别')}</w:tc></w:tr><w:tr><w:tc>${p('保留')}</w:tc><w:tc>${p('全部内容')}</w:tc></w:tr></w:tbl></w:body></w:document>`
      )
      const path = join(dir, 'generated.docx')
      await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
      const chunks = await parseDocx(path)
      expect(chunks[0].heading).toBe('第一章 合成 › 2.3验证方法')
      expect(chunks.every((c) => c.text.length <= 1800)).toBe(true)
      expect(chunks[0].locator).toEqual({ type: 'FragmentSelector', value: 'block=2' })
      expect(chunks.map((c) => c.text).join('')).toContain('2.3.2条件：≤20min/件。')
      expect(chunks.map((c) => c.text).join('')).toContain('- 清单事项')
      expect(chunks.find((c) => c.kind === 'table')?.text).toContain('colspan="2"')
      expect(chunks.find((c) => c.kind === 'table')?.text).toContain('表1 合成数据')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
