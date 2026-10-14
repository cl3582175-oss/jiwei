import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import type { SegmentInput } from '../segments'

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
const mdCell = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
export function tableSegments(sheet: string, rows: TableRow[]): SegmentInput[] {
  const nonempty = rows.filter((r) => r.cells.some((c) => c.trim()))
  if (!nonempty.length) return []
  const width = Math.max(...nonempty.map((r) => r.cells.length)),
    [header, ...data] = nonempty
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => mdCell(cells[i] ?? '')).join(' | ')} |`
  const prefix = `## ${sheet}\n${line(header.cells)}\n${line(Array(width).fill('---'))}`
  const parts: SegmentInput[] = []
  for (let i = 0; i < Math.max(1, data.length); i += 50) {
    const batch = data.slice(i, i + 50)
    parts.push({
      kind: 'table',
      locator: {
        sheet,
        rowStart: batch[0]?.row ?? header.row,
        rowEnd: batch.at(-1)?.row ?? header.row,
        totalRows: data.length,
        value: `sheet=${sheet},rows=${batch[0]?.row ?? header.row}-${batch.at(-1)?.row ?? header.row}`
      },
      text: `${prefix}${batch.length ? '\n' + batch.map((r) => line(r.cells)).join('\n') : ''}\n（共 ${data.length} 行数据）`
    })
  }
  return parts
}
