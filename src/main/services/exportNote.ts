import { app, BrowserWindow, dialog, nativeImage } from 'electron'
import { copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { tmpdir } from 'os'
import log from 'electron-log/main'
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild
} from 'docx'
import { getNote } from './notes'
import { loadDoc, stateToContent } from './docs'
import { assetPath } from './assets'
import { getSettings } from './settings'
import { cornellParts, embedMarkdown, toHtml, toMarkdown, type EmbedImage, type EmbedsData, type ExportMeta } from '../lib/exportFormats'
import { nodeText } from '../lib/derive'
import type { DocNode } from '@shared/types'

// 笔记导出：Markdown（附图片文件夹）/ HTML（单文件）/ PDF（Chromium 打印）/ Word（docx）。
// 富内容块的图片由渲染进程截取后传入（SVG / PNG）；没有图片时以文字形式导出。

export type ExportFormat = 'md' | 'html' | 'pdf' | 'docx'

const ASSET = /^jiwei:\/\/asset\/([0-9a-f]{64})\.([a-z0-9]{1,10})$/i
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
}
const safeName = (s: string): string =>
  (s || 'note')
    .replace(/[\\/:*?"<>|\n\r]+/g, ' ')
    .trim()
    .slice(0, 80) || 'note'

async function assetDataUrl(src: string): Promise<string> {
  const m = ASSET.exec(src)
  if (!m) return src
  try {
    const buf = await readFile(assetPath(m[1].toLowerCase(), m[2].toLowerCase()))
    return `data:${MIME[m[2].toLowerCase()] ?? 'application/octet-stream'};base64,${buf.toString('base64')}`
  } catch {
    return ''
  }
}

/** 收集文档中的素材图片地址 */
function assetSrcs(nodes: DocNode[]): string[] {
  const out: string[] = []
  const walk = (n: DocNode): void => {
    if (n.type === 'image' && typeof n.attrs?.src === 'string' && ASSET.test(n.attrs.src)) out.push(n.attrs.src)
    n.content?.forEach(walk)
  }
  nodes.forEach(walk)
  return out
}

const dataUrlBytes = (u: string): Buffer => Buffer.from(u.slice(u.indexOf(',') + 1), 'base64')

export async function exportNote(
  win: BrowserWindow | null,
  noteId: string,
  format: ExportFormat,
  images: Record<string, EmbedImage>
): Promise<string | null> {
  const note = getNote(noteId)
  if (!note) throw new Error('Note not found')
  const lang = getSettings().language
  const zh = lang.startsWith('zh')
  const meta: ExportMeta = { title: note.title, learnedAt: note.learnedAt, lang }
  const { doc, embeds } = stateToContent(loadDoc(noteId))

  const opts = {
    defaultPath: join(app.getPath('documents'), `${safeName(note.title || (zh ? '无标题' : 'Untitled'))}.${format}`),
    filters: [{ name: format.toUpperCase(), extensions: [format] }]
  }
  // 端到端测试：开发构建可指定导出目录，跳过保存对话框
  const testDir = !app.isPackaged ? process.env.JIWEI_EXPORT_DIR : undefined
  let file: string
  if (testDir) file = join(testDir, basename(opts.defaultPath))
  else {
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    file = r.filePath
  }

  if (format === 'md') {
    // 图片放在同名文件夹中，Markdown 中使用相对路径
    const dirName = `${basename(file, extname(file))}.assets`
    const dir = join(file, '..', dirName)
    let made = false
    const ensure = async (): Promise<void> => {
      if (!made) await mkdir(dir, { recursive: true })
      made = true
    }
    const assetMap = new Map<string, string>()
    for (const src of assetSrcs(doc.content ?? [])) {
      const m = ASSET.exec(src)!
      const name = `${m[1].slice(0, 12)}.${m[2]}`
      await ensure()
      await copyFile(assetPath(m[1].toLowerCase(), m[2].toLowerCase()), join(dir, name)).catch(() => {})
      assetMap.set(src, `${dirName}/${name}`)
    }
    const imageMap = new Map<string, string>()
    for (const [id, img] of Object.entries(images)) {
      if (!img.png) continue
      await ensure()
      const name = `${embeds[id]?.kind ?? 'embed'}-${id.slice(-8)}.png`
      await writeFile(join(dir, name), dataUrlBytes(img.png))
      imageMap.set(id, `${dirName}/${name}`)
    }
    await writeFile(
      file,
      toMarkdown(doc, embeds, meta, { image: (id) => imageMap.get(id) ?? null, asset: (s) => assetMap.get(s) ?? s }),
      'utf8'
    )
    return file
  }

  // HTML / PDF：单文件，图片内联
  const inline = new Map<string, string>()
  for (const src of assetSrcs(doc.content ?? [])) inline.set(src, await assetDataUrl(src))
  const html = toHtml(doc, embeds, meta, images, (s) => inline.get(s) ?? s)
  if (format === 'html') {
    await writeFile(file, html, 'utf8')
    return file
  }
  if (format === 'pdf') {
    const tmp = join(tmpdir(), `jiwei-export-${Date.now()}.html`)
    await writeFile(tmp, html, 'utf8')
    const w = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } })
    try {
      await w.loadFile(tmp)
      const pdf = await w.webContents.printToPDF({
        pageSize: 'A4',
        printBackground: true,
        margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 }
      })
      await writeFile(file, pdf)
    } finally {
      w.destroy()
      await rm(tmp, { force: true })
    }
    return file
  }

  // Word
  await writeFile(file, await toDocx(doc.content ?? [], embeds, meta, images))
  return file
}

/* ——— Word ——— */

const BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'DFE3DF' }
const ACCENT = '2F6F62'

function runs(nodes: DocNode[] | undefined, cue = false): ParagraphChild[] {
  const out: ParagraphChild[] = []
  for (const n of nodes ?? []) {
    if (n.type === 'hardBreak') {
      out.push(new TextRun({ text: '', break: 1 }))
      continue
    }
    if (n.type === 'inlineMath') {
      out.push(new TextRun({ text: String(n.attrs?.latex ?? ''), font: 'Menlo', ...(cue ? { color: ACCENT } : {}) }))
      continue
    }
    if (n.type !== 'text') continue
    const marks = new Set((n.marks ?? []).map((m) => m.type))
    const run = new TextRun({
      text: n.text ?? '',
      ...(cue ? { color: ACCENT, font: 'KaiTi' } : {}),
      bold: marks.has('bold'),
      italics: marks.has('italic'),
      strike: marks.has('strike'),
      ...(marks.has('code') ? { font: 'Menlo' } : {})
    })
    const link = n.marks?.find((m) => m.type === 'link')?.attrs?.href
    out.push(typeof link === 'string' && /^https?:/i.test(link) ? new ExternalHyperlink({ link, children: [run] }) : run)
  }
  return out
}

function imageRun(png: string, width: number, height: number, maxW: number): ImageRun {
  const k = Math.min(1, maxW / width)
  return new ImageRun({
    type: 'png',
    data: dataUrlBytes(png),
    transformation: { width: Math.round(width * k), height: Math.round(height * k) }
  })
}

function docxBlocks(
  nodes: DocNode[],
  embeds: EmbedsData,
  images: Record<string, EmbedImage>,
  zh: boolean,
  maxW: number,
  depth = 0
): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = []
  for (const n of nodes) {
    switch (n.type) {
      case 'blockMath':
        out.push(new Paragraph({ children: [new TextRun({ text: String(n.attrs?.latex ?? ''), font: 'Menlo' })] }))
        break
      case 'paragraph':
        out.push(new Paragraph({ children: runs(n.content), spacing: { after: 80 } }))
        break
      case 'heading':
        out.push(
          new Paragraph({
            children: runs(n.content),
            heading: Number(n.attrs?.level) <= 2 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_4
          })
        )
        break
      case 'bulletList':
      case 'orderedList':
        ;(n.content ?? []).forEach((li, i) => {
          const [first, ...rest] = li.content ?? []
          out.push(
            new Paragraph({
              children: [...(n.type === 'orderedList' ? [new TextRun(`${i + 1}. `)] : []), ...runs(first?.content)],
              ...(n.type === 'bulletList' ? { bullet: { level: Math.min(depth, 8) } } : { indent: { left: 360 * (depth + 1) } })
            })
          )
          out.push(...docxBlocks(rest, embeds, images, zh, maxW, depth + 1))
        })
        break
      case 'blockquote':
        for (const c of n.content ?? [])
          out.push(new Paragraph({ children: runs(c.content), indent: { left: 360 }, border: { left: { ...BORDER, size: 12, space: 8 } } }))
        break
      case 'codeBlock':
        for (const line of (n.content ?? [])
          .map((c) => c.text ?? '')
          .join('')
          .split('\n'))
          out.push(
            new Paragraph({
              children: [new TextRun({ text: line || ' ', font: 'Menlo', size: 18 })],
              shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F5F2' }
            })
          )
        break
      case 'table':
        out.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: (n.content ?? []).map(
              (r) =>
                new TableRow({
                  children: (r.content ?? []).map(
                    (c) =>
                      new TableCell({
                        children: docxBlocks(c.content ?? [], embeds, images, zh, maxW / 2).filter(
                          (x): x is Paragraph => x instanceof Paragraph
                        ),
                        shading: c.type === 'tableHeader' ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F5F2' } : undefined,
                        borders: { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER }
                      })
                  )
                })
            )
          })
        )
        break
      case 'image': {
        const src = String(n.attrs?.src ?? '')
        const m = ASSET.exec(src)
        if (m && /png|jpe?g/i.test(m[2])) {
          const path = assetPath(m[1].toLowerCase(), m[2].toLowerCase())
          const img = nativeImage.createFromPath(path)
          const size = img.getSize()
          if (size.width)
            out.push(
              new Paragraph({
                children: [imageRun(`data:image/png;base64,${img.toPNG().toString('base64')}`, size.width, size.height, maxW)]
              })
            )
        }
        break
      }
      case 'embed': {
        const id = String(n.attrs?.id ?? '')
        const e = embeds[id]
        const img = images[id]
        if (img?.png && img.width && img.height)
          out.push(new Paragraph({ children: [imageRun(img.png, img.width, img.height, maxW)], alignment: AlignmentType.CENTER }))
        else if (e?.kind)
          for (const line of embedMarkdown(e.kind, e.data, zh).split('\n'))
            if (!line.startsWith('```')) out.push(new Paragraph({ children: [new TextRun({ text: line.replace(/[*`]/g, '') })] }))
        break
      }
      default:
        if (n.content) out.push(...docxBlocks(n.content, embeds, images, zh, maxW, depth))
    }
  }
  return out
}

async function toDocx(content: DocNode[], embeds: EmbedsData, meta: ExportMeta, images: Record<string, EmbedImage>): Promise<Buffer> {
  const zh = meta.lang.startsWith('zh')
  const { rows, summary } = cornellParts({ type: 'doc', content })
  const cell = (children: (Paragraph | Table)[], width: number, fill?: string): TableCell =>
    new TableCell({
      children: children.length ? children : [new Paragraph('')],
      width: { size: width, type: WidthType.PERCENTAGE },
      borders: { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER },
      margins: { top: 100, bottom: 100, left: 140, right: 140 },
      ...(fill ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill } } : {})
    })
  // 线索保留楷体；数学叶节点不能被 nodeText 合并成普通文字，否则会丢失独立的代码字体。
  const cueRuns = (node: DocNode): ParagraphChild[] => {
    if (node.type === 'blockMath') return runs([{ ...node, type: 'inlineMath' }], true)
    if (!node.content) return runs([node], true)
    return node.content.flatMap((child, i) => [
      ...(i && child.type !== 'text' && child.type !== 'inlineMath' && child.type !== 'hardBreak'
        ? [new TextRun({ text: '', break: 1 })]
        : []),
      ...cueRuns(child)
    ])
  }
  const cueBlocks = (nodes: DocNode[]): Paragraph[] => nodes.map((n) => new Paragraph({ children: cueRuns(n) }))
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      ...rows.map((r) => new TableRow({ children: [cell(cueBlocks(r.cue), 30), cell(docxBlocks(r.body, embeds, images, zh, 420), 70)] })),
      ...(nodeText({ content: summary }).trim()
        ? [
            new TableRow({
              children: [
                new TableCell({
                  columnSpan: 2,
                  children: [
                    new Paragraph({ children: [new TextRun({ text: zh ? '总结' : 'Summary', bold: true, color: '5D6661', size: 18 })] }),
                    ...docxBlocks(summary, embeds, images, zh, 600)
                  ],
                  borders: { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER },
                  margins: { top: 100, bottom: 100, left: 140, right: 140 },
                  shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F5F2' }
                })
              ]
            })
          ]
        : [])
    ]
  })
  const d = new Document({
    creator: zh ? '积微' : 'Jiwei',
    title: meta.title,
    styles: { default: { document: { run: { font: zh ? 'PingFang SC' : 'Calibri', size: 22 } } } },
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun({ text: meta.title || (zh ? '无标题' : 'Untitled'), bold: true, size: 40 })],
            spacing: { after: 80 }
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: `${zh ? '学习于' : 'Learned'} ${new Intl.DateTimeFormat(meta.lang, { dateStyle: 'long' }).format(new Date(meta.learnedAt))}`,
                color: '5D6661',
                size: 18
              })
            ],
            spacing: { after: 240 }
          }),
          table
        ]
      }
    ]
  })
  try {
    return await Packer.toBuffer(d)
  } catch (e) {
    log.error('[export] docx failed', e)
    throw e
  }
}
