import { app, BrowserWindow, dialog } from 'electron'
import { rm, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { tmpdir } from 'os'
import { AlignmentType, Document, HeadingLevel, LevelFormat, Packer, Paragraph, TextRun, type ParagraphChild } from 'docx'
import type { ArticlePart, SlidePart, Work, WorkExport } from '@shared/works'
import type { DocNode } from '@shared/types'
import { markdownToNodes } from '../../lib/markdown'
import { blocksHtml } from '../../lib/exportFormats'
import { getSettings } from '../settings'
import { getWork, recordExport } from './index'

// 作品导出（v0.9）：长文 → Markdown / Word / PDF（文章版式，非康奈尔表格）；课件 → PPTX（讲者备注写明出处）。

export type WorkExportFormat = 'md' | 'docx' | 'pdf' | 'pptx'

const safeName = (s: string): string =>
  s
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .trim()
    .slice(0, 80) || 'work'
const zh = (): boolean => getSettings().language.startsWith('zh')

async function target(win: BrowserWindow | null, w: Work, format: WorkExportFormat): Promise<string | null> {
  const defaultPath = join(app.getPath('documents'), `${safeName(w.title || w.topic)}.${format}`)
  // 端到端测试：开发构建可指定导出目录，跳过保存对话框
  const testDir = !app.isPackaged ? process.env.JIWEI_EXPORT_DIR : undefined
  if (testDir) return join(testDir, basename(defaultPath))
  const opts = { defaultPath, filters: [{ name: format.toUpperCase(), extensions: [format] }] }
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  return r.canceled || !r.filePath ? null : r.filePath
}

/** 参考素材：只列出成品里引用到的 */
function references(w: Work): { ref: string; title: string }[] {
  const used = new Set((w.content?.parts ?? []).flatMap((p) => p.sources))
  return w.materials.filter((m) => used.has(m.ref)).map((m) => ({ ref: m.ref, title: m.title }))
}

/* ——— 长文 ——— */

function articleMarkdown(w: Work, parts: ArticlePart[]): string {
  const refs = references(w)
  const num = new Map(refs.map((r, i) => [r.ref, i + 1]))
  const cite = (s: string): string => s.replace(/\[(M\d{1,2})\]/g, (m, r: string) => (num.has(r) ? `[^${num.get(r)}]` : ''))
  const out = [`# ${w.title || w.topic}`]
  if (w.audience) out.push(`> ${zh() ? '写给' : 'For'}：${w.audience}`)
  for (const p of parts) {
    out.push(`## ${p.title}`)
    if (p.body.trim()) out.push(cite(p.body.trim()))
  }
  if (refs.length) {
    out.push(`---`)
    for (const r of refs) out.push(`[^${num.get(r.ref)}]: ${r.title}`)
  }
  return out.join('\n\n') + '\n'
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function articleHtml(w: Work, parts: ArticlePart[]): string {
  const refs = references(w)
  const num = new Map(refs.map((r, i) => [r.ref, i + 1]))
  const section = (p: ArticlePart): string => {
    // 引用标记先换成占位文本，渲染后再换成上标，避免被当作 Markdown 链接
    const md = p.body.replace(/\[(M\d{1,2})\]/g, (_, r: string) => (num.has(r) ? `⟦${num.get(r)}⟧` : ''))
    const html = blocksHtml(
      markdownToNodes(md) as DocNode[],
      () => '',
      (s) => s
    ).replace(/⟦(\d+)⟧/g, '<sup>$1</sup>')
    return `<h2>${esc(p.title)}</h2>${html}`
  }
  return `<!doctype html><html lang="${zh() ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><title>${esc(w.title)}</title><style>
  @page { margin: 22mm 20mm; }
  body { font-family: "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", -apple-system, sans-serif; color: #1f2523; line-height: 1.85; font-size: 11pt; max-width: 680px; margin: 0 auto; }
  h1 { font-family: "Songti SC", "Noto Serif CJK SC", Georgia, serif; font-size: 24pt; line-height: 1.3; margin: 0 0 6pt; }
  .for { color: #6b746f; font-size: 10pt; margin-bottom: 22pt; }
  h2 { font-family: "Songti SC", "Noto Serif CJK SC", Georgia, serif; font-size: 15pt; margin: 22pt 0 6pt; padding-left: 9pt; border-left: 3px solid #2F6F62; }
  p { margin: 6pt 0; text-align: justify; }
  sup { color: #2F6F62; font-size: 7.5pt; }
  blockquote { margin: 8pt 0; padding: 4pt 12pt; border-left: 3px solid #d7dfdb; color: #4a524e; }
  code { background: #f1f4f2; padding: 1px 4px; border-radius: 3px; font-size: 9.5pt; }
  .refs { margin-top: 26pt; padding-top: 10pt; border-top: 1px solid #dfe5e1; font-size: 9pt; color: #6b746f; }
  .refs li { margin: 2pt 0; }
</style></head><body>
<h1>${esc(w.title || w.topic)}</h1>
${w.audience ? `<div class="for">${zh() ? '写给' : 'For'}：${esc(w.audience)}</div>` : ''}
${parts.map(section).join('\n')}
${refs.length ? `<ol class="refs">${refs.map((r) => `<li>${esc(r.title)}</li>`).join('')}</ol>` : ''}
</body></html>`
}

function runsOf(nodes: DocNode[] | undefined): ParagraphChild[] {
  return (nodes ?? []).flatMap((n): ParagraphChild[] => {
    if (n.type === 'text') {
      const marks = new Set((n.marks ?? []).map((m) => m.type))
      return [
        new TextRun({
          text: String(n.text ?? '').replace(/\[(M\d{1,2})\]/g, ''),
          bold: marks.has('bold'),
          italics: marks.has('italic'),
          font: marks.has('code') ? 'Menlo' : undefined
        })
      ]
    }
    if (n.type === 'hardBreak') return [new TextRun({ break: 1 })]
    return runsOf(n.content)
  })
}

function docxParagraphs(nodes: DocNode[]): Paragraph[] {
  const out: Paragraph[] = []
  for (const n of nodes) {
    if (n.type === 'heading') out.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: runsOf(n.content) }))
    else if (n.type === 'bulletList' || n.type === 'orderedList')
      for (const li of n.content ?? [])
        for (const p of li.content ?? [])
          out.push(
            new Paragraph({
              children: runsOf(p.content),
              numbering: { reference: n.type === 'orderedList' ? 'ordered' : 'bullets', level: 0 }
            })
          )
    else if (n.type === 'blockquote')
      for (const p of n.content ?? []) out.push(new Paragraph({ children: runsOf(p.content), indent: { left: 400 } }))
    else if (n.type === 'codeBlock')
      out.push(
        new Paragraph({ children: [new TextRun({ text: (n.content ?? []).map((t) => t.text ?? '').join(''), font: 'Menlo', size: 18 })] })
      )
    else out.push(new Paragraph({ children: runsOf(n.content), spacing: { after: 120, line: 360 }, alignment: AlignmentType.JUSTIFIED }))
  }
  return out
}

async function articleDocx(w: Work, parts: ArticlePart[]): Promise<Buffer> {
  const refs = references(w)
  const children: Paragraph[] = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(w.title || w.topic)] })]
  if (w.audience)
    children.push(new Paragraph({ children: [new TextRun({ text: `${zh() ? '写给' : 'For'}：${w.audience}`, color: '6B746F' })] }))
  for (const p of parts) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(p.title)] }))
    children.push(...docxParagraphs(markdownToNodes(p.body) as DocNode[]))
  }
  if (refs.length) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(zh() ? '参考素材' : 'References')] }))
    for (const r of refs)
      children.push(
        new Paragraph({ children: [new TextRun({ text: r.title, color: '6B746F' })], numbering: { reference: 'ordered', level: 0 } })
      )
  }
  const doc = new Document({
    styles: { default: { document: { run: { font: zh() ? 'PingFang SC' : 'Calibri', size: 22 } } } },
    numbering: {
      config: [
        { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT }] },
        { reference: 'ordered', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT }] }
      ]
    },
    sections: [{ children }]
  })
  return Packer.toBuffer(doc)
}

async function htmlToPdf(html: string, file: string): Promise<void> {
  const tmp = join(tmpdir(), `jiwei-work-${Date.now()}.html`)
  await writeFile(tmp, html, 'utf8')
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } })
  try {
    await w.loadFile(tmp)
    await writeFile(file, await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true }))
  } finally {
    w.destroy()
    await rm(tmp, { force: true })
  }
}

/* ——— 课件 ——— */

const INK = '1F2523',
  MUTED = '6B746F',
  ACCENT = '2F6F62',
  SOFT = 'E7F0EC',
  PAPER = 'FBFCFA'

async function slidesPptx(w: Work, parts: SlidePart[]): Promise<Buffer> {
  const { default: PptxGenJS } = await import('pptxgenjs')
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE' // 13.33 × 7.5 in
  pptx.title = w.title || w.topic
  const font = zh() ? 'PingFang SC' : 'Calibri'
  const head = zh() ? 'Songti SC' : 'Georgia'
  const byRef = new Map(w.materials.map((m) => [m.ref, m.title]))
  const sourceNote = (p: SlidePart): string => {
    const titles = p.sources.map((r) => byRef.get(r)).filter(Boolean)
    return titles.length ? `\n\n${zh() ? '出处' : 'Sources'}：${titles.join('；')}` : ''
  }
  parts.forEach((p, i) => {
    const s = pptx.addSlide()
    s.background = { color: PAPER }
    if (i === 0) {
      // 标题页：左侧色带 + 大标题 + 受众
      s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.35, h: 7.5, fill: { color: ACCENT } })
      s.addText(p.title, { x: 1.1, y: 2.3, w: 11, h: 1.6, fontFace: head, fontSize: 40, bold: true, color: INK, valign: 'bottom' })
      const sub = p.bullets.join('  ·  ') || w.audience
      if (sub) s.addText(sub, { x: 1.1, y: 4.05, w: 11, h: 0.8, fontFace: font, fontSize: 18, color: MUTED, valign: 'top' })
    } else {
      s.addShape(pptx.ShapeType.rect, { x: 0.7, y: 0.62, w: 0.09, h: 0.62, fill: { color: ACCENT } })
      s.addText(p.title, { x: 0.95, y: 0.5, w: 11.6, h: 0.86, fontFace: head, fontSize: 28, bold: true, color: INK, valign: 'middle' })
      s.addText(
        p.bullets.map((b) => ({ text: b, options: { bullet: { code: '25A0', indent: 22 }, paraSpaceAfter: 14 } })),
        { x: 1.0, y: 1.75, w: 11.3, h: 4.9, fontFace: font, fontSize: 20, color: INK, valign: 'top', lineSpacingMultiple: 1.15 }
      )
      s.addShape(pptx.ShapeType.rect, { x: 0, y: 7.12, w: 13.33, h: 0.38, fill: { color: SOFT } })
      s.addText(w.title || w.topic, { x: 0.7, y: 7.12, w: 9, h: 0.38, fontFace: font, fontSize: 10, color: MUTED, valign: 'middle' })
      s.addText(`${i + 1} / ${parts.length}`, {
        x: 11.2,
        y: 7.12,
        w: 1.45,
        h: 0.38,
        fontFace: font,
        fontSize: 10,
        color: MUTED,
        align: 'right',
        valign: 'middle'
      })
    }
    s.addNotes(`${p.notes}${sourceNote(p)}`)
  })
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer
}

/** 导出作品；返回文件路径（取消时为 null） */
export async function exportWork(win: BrowserWindow | null, id: string, format: WorkExportFormat): Promise<string | null> {
  const w = getWork(id)
  if (!w.content) throw new Error(zh() ? '作品还没有内容' : 'The work has no content yet')
  if (w.content.kind === 'video') throw new Error(zh() ? '讲解视频请在成品步骤渲染导出' : 'Render videos from the Finish step')
  if (w.content.kind === 'slides' && format !== 'pptx' && format !== 'md') throw new Error('Unsupported format')
  if (w.content.kind === 'article' && format === 'pptx') throw new Error('Unsupported format')
  const file = await target(win, w, format)
  if (!file) return null
  if (w.content.kind === 'article') {
    const parts = w.content.parts
    if (format === 'md') await writeFile(file, articleMarkdown(w, parts), 'utf8')
    else if (format === 'docx') await writeFile(file, await articleDocx(w, parts))
    else await htmlToPdf(articleHtml(w, parts), file)
  } else if (format === 'pptx') await writeFile(file, await slidesPptx(w, w.content.parts))
  else if (w.content.kind === 'slides')
    await writeFile(
      file,
      [
        `# ${w.title || w.topic}`,
        ...w.content.parts.map((p, i) =>
          [`## ${i + 1}. ${p.title}`, ...p.bullets.map((b) => `- ${b}`), p.notes ? `> ${p.notes}` : ''].filter(Boolean).join('\n')
        )
      ].join('\n\n') + '\n',
      'utf8'
    )
  const record: WorkExport = { format, path: file, at: Date.now() }
  recordExport(id, record)
  return file
}
