import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseEpubStructured, parseHtmlStructured, parsePdfStructured } from './parsers'
import { readingHtmlText } from '../main/lib/reading'
import { normalizeQuery } from '../main/lib/textNormalize'

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'rag-structure-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
describe('structured parser entry points', () => {
  it('saved HTML and native quote retain the same visible text across extraction normalization', async () =>
    withDir(async (dir) => {
      const html =
        '<html><body><article><p>前言 <span>⻛压Ａ１０２</span><br>稳定条件（合成）😀。<span hidden>隐藏干扰</span></p></article></body></html>'
      const path = join(dir, 'native-quote.html')
      await writeFile(path, html)
      const raw = readingHtmlText(html),
        result = await parseHtmlStructured(path)
      expect(raw).toContain('⻛压Ａ１０２')
      expect(result.segments[0].text).toContain('风压A102')
      expect(normalizeQuery(result.segments.map((s) => s.text).join('\n'))).toBe(normalizeQuery(raw))
    }))
  it('extracts saved article structure, titles and tables', async () =>
    withDir(async (dir) => {
      const path = join(dir, 'article.html')
      await writeFile(
        path,
        '<html><head><title>合成资料</title></head><body><article><h1>条件</h1><p>⼈需要完整证据。</p><table><tr><th>名</th><th>值</th></tr><tr><td>甲</td><td>2</td></tr><tr><td>乙</td><td>3</td></tr><tr><td>丙</td><td>4</td></tr></table></article></body></html>'
      )
      const result = await parseHtmlStructured(path)
      expect(result.title).toBe('合成资料')
      expect(result.segments[0]).toMatchObject({ heading: '条件', text: '人需要完整证据。' })
      expect(result.segments[1].kind).toBe('table')
    }))
  it('retains chapter locators, headings and code from a generated EPUB', async () =>
    withDir(async (dir) => {
      const zip = new JSZip()
      zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>')
      zip.file(
        'OEBPS/book.opf',
        '<package><manifest><item id="c1" href="one.xhtml"/><item id="c2" href="two.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>'
      )
      zip.file('OEBPS/one.xhtml', '<html><body><h1>First chapter</h1><p>Evidence one.</p><pre>x  =  2</pre></body></html>')
      zip.file('OEBPS/two.xhtml', '<html><body><h2>Second chapter</h2><blockquote>Evidence two.</blockquote></body></html>')
      const path = join(dir, 'generated.epub')
      await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
      const progress: number[] = []
      const chunks = await parseEpubStructured(path, (p) => progress.push(p))
      expect(chunks.map((c) => c.locator.value)).toEqual(['chapter=1', 'chapter=1', 'chapter=2'])
      expect(chunks[1]).toMatchObject({ kind: 'code', heading: 'First chapter', text: 'x  =  2' })
      expect(progress).toEqual([0.5, 1])
    }))
  it('groups actual PDF text across pages and reports pageEnd', async () =>
    withDir(async (dir) => {
      const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        ...[1, 2].map((n) => {
          const stream = `BT /F1 12 Tf 30 700 Td (Page ${n} evidence is retained.) Tj ET`
          return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
        })
      ]
      let pdf = '%PDF-1.4\n'
      const offsets = [0]
      for (const [i, o] of objects.entries()) {
        offsets.push(Buffer.byteLength(pdf))
        pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
      }
      const xref = Buffer.byteLength(pdf)
      pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
        .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
      const path = join(dir, 'generated.pdf')
      await writeFile(path, pdf)
      const result = await parsePdfStructured(path, () => {})
      expect(result.segments).toHaveLength(1)
      expect(result.segments[0]).toMatchObject({ kind: 'page', locator: { value: 'page=1', pageEnd: 2 } })
      expect(result.segments[0].text).toContain('Page 2 evidence is retained.')
      expect(result.pages).toEqual([])
    }))
})
