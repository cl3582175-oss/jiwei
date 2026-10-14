import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { SegmentInput } from '../segments'
import { tableSegments } from './ooxml'

export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\ufeff/, '')
  } catch {
    try {
      return new TextDecoder('gbk', { fatal: true }).decode(bytes)
    } catch {
      throw new Error('无法解码文件，请另存为 UTF-8 CSV / Cannot decode file; save as UTF-8')
    }
  }
}

function separator(raw: string): string {
  let quoted = false
  const counts = new Map([
    [',', 0],
    [';', 0],
    ['\t', 0]
  ])
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === '"') {
      if (quoted && raw[i + 1] === '"') i++
      else quoted = !quoted
    } else if (!quoted && /[\r\n]/.test(c)) break
    else if (!quoted && counts.has(c)) counts.set(c, counts.get(c)! + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0][0]
}

export function csvRows(raw: string): string[][] {
  const sep = separator(raw),
    rows: string[][] = []
  let row: string[] = [],
    cell = '',
    quoted = false,
    closed = false
  const field = (): void => {
    row.push(cell)
    cell = ''
    closed = false
  }
  const record = (): void => {
    field()
    rows.push(row)
    row = []
  }
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (quoted) {
      if (c === '"') {
        if (raw[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          quoted = false
          closed = true
        }
      } else cell += c
    } else if (c === sep) field()
    else if (c === '\n' || c === '\r') {
      record()
      if (c === '\r' && raw[i + 1] === '\n') i++
    } else if (c === '"' && !cell && !closed) quoted = true
    else {
      if (closed || c === '"') throw new Error('Invalid CSV quoting')
      cell += c
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合 / Unclosed CSV quote')
  if (cell || row.length || closed) record()
  return rows
}

export async function parseCsv(path: string, name = basename(path)): Promise<SegmentInput[]> {
  const rows = csvRows(decodeText(await readFile(path)))
  return tableSegments(
    name,
    rows.map((cells, i) => ({ row: i + 1, cells }))
  )
}
