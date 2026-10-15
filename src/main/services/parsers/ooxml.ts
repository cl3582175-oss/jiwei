import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import type { SegmentInput } from '../segments'
import { normalizeExtracted } from '../../lib/textNormalize'
import { chunkBlocks, EMBED_MAX_CHARS } from '../../lib/chunker'

export type Xml = Record<string, unknown>
export const elements = (v: unknown): Xml[] =>
  (Array.isArray(v) ? v : v ? [v] : []).filter((x): x is Xml => typeof x === 'object' && x !== null)
export const xmlText = (v: unknown): string => {
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  if (Array.isArray(v)) return v.map(xmlText).join('')
  if (v && typeof v === 'object')
    return Object.entries(v)
      .filter(([key]) => !key.startsWith('@_') && key !== 'rPh')
      .map(([, value]) => xmlText(value))
      .join('')
  return ''
}

const MAX_XML = 200 * 1024 * 1024
export async function openOffice(path: string): Promise<JSZip> {
  const zip = await JSZip.loadAsync(await readFile(path))
  // ZIP 可以极小但解压后极大；在分配 XML 字符串前检查包内声明的膨胀量。
  const total = Object.values(zip.files).reduce(
    (sum, entry) => sum + ((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0),
    0
  )
  if (total > MAX_XML) throw new Error('Document too large after decompression')
  return zip
}
export async function readXml(zip: JSZip, path: string): Promise<Xml> {
  const entry = zip.file(path)
  if (!entry) return {}
  const value = await entry.async('string')
  if (value.length > MAX_XML || /<!DOCTYPE|<!ENTITY/i.test(value)) throw new Error('Unsupported XML document')
  return new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false
  }).parse(value) as Xml
}

export function relationshipPath(base: string, target: unknown): string {
  if (typeof target !== 'string' || /^[a-z]+:/i.test(target)) throw new Error('Invalid Office relationship')
  const path = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(posix.dirname(base), target))
  if (path.startsWith('../') || path.startsWith('/')) throw new Error('Invalid Office relationship')
  return path
}

export interface TableRow {
  row: number
  cells: string[]
}
const mdCell = (value: string): string => normalizeExtracted(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
export function tableSegments(sheet: string, rows: TableRow[]): SegmentInput[] {
  const nonempty = rows.filter((r) => r.cells.some((c) => c.trim()))
  if (!nonempty.length) return []
  const width = Math.max(...nonempty.map((r) => r.cells.length)),
    [header, ...data] = nonempty
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => mdCell(cells[i] ?? '')).join(' | ')} |`
  const prefix = `## ${normalizeExtracted(sheet)}\n${line(header.cells)}\n${line(Array(width).fill('---'))}`
  const footer = `\n（共 ${data.length} 行数据）`
  const parts: SegmentInput[] = []
  let start = 0,
    batch: TableRow[] = []
  const render = (group: TableRow[]): string => `${prefix}${group.length ? '\n' + group.map((r) => line(r.cells)).join('\n') : ''}${footer}`
  const flush = (): void => {
    const locator = {
      sheet,
      dataStart: start,
      rowStart: batch[0]?.row ?? header.row,
      rowEnd: batch.at(-1)?.row ?? header.row,
      totalRows: data.length,
      value: `sheet=${sheet},rows=${batch[0]?.row ?? header.row}-${batch.at(-1)?.row ?? header.row}`
    }
    const text = render(batch)
    if (text.length > EMBED_MAX_CHARS.zh) {
      parts.push(
        ...chunkBlocks(
          [
            { type: 'heading', level: 1, text: sheet },
            { type: 'table', caption: `## ${sheet}`, header: header.cells, rows: batch.map((r) => r.cells) }
          ],
          { locatorOf: () => locator }
        )
      )
    } else parts.push({ kind: 'table', heading: normalizeExtracted(sheet).slice(0, 120), locator, text })
    start += batch.length
    batch = []
  }
  // 表格资料即使只有一行也保留表头与列关系；它不是 Word 中的签字版式表。
  for (const row of data) {
    if (
      batch.length &&
      ((batch.length >= 3 && render([...batch, row]).length > 700) || render([...batch, row]).length > EMBED_MAX_CHARS.zh)
    )
      flush()
    batch.push(row)
  }
  if (batch.length || !data.length) flush()
  return parts
}
