import { elements, openOffice, readXml, relationshipPath, tableSegments, xmlText, type Xml, type TableRow } from './ooxml'
import type { SegmentInput } from '../segments'

function col(ref: unknown, fallback: number): number {
  const letters = typeof ref === 'string' ? /^[A-Z]+/i.exec(ref)?.[0] : null
  if (!letters) return fallback
  const n = [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1
  if (n >= 16384) throw new Error('Invalid spreadsheet column')
  return n
}

export async function parseXlsx(path: string): Promise<SegmentInput[]> {
  const zip = await openOffice(path)
  const workbook = (await readXml(zip, 'xl/workbook.xml')).workbook as Xml | undefined
  if (!workbook) throw new Error('Invalid xlsx workbook')
  const sheets = elements((workbook.sheets as Xml | undefined)?.sheet)
  const relations = elements(((await readXml(zip, 'xl/_rels/workbook.xml.rels')).Relationships as Xml | undefined)?.Relationship)
  const targets = new Map(relations.filter((r) => r['@_TargetMode'] !== 'External').map((r) => [r['@_Id'], r['@_Target']]))
  const shared = elements(((await readXml(zip, 'xl/sharedStrings.xml')).sst as Xml | undefined)?.si).map(xmlText)
  const output: SegmentInput[] = []
  for (const sheet of sheets) {
    const target = targets.get(sheet['@_id'])
    if (!target) throw new Error('Missing worksheet relationship')
    const data = ((await readXml(zip, relationshipPath('xl/workbook.xml', target))).worksheet as Xml | undefined)?.sheetData as
      Xml | undefined
    const rows: TableRow[] = elements(data?.row).map((row, i) => {
      const cells: string[] = []
      elements(row.c).forEach((c, j) => {
        const value = xmlText(c.v),
          type = c['@_t']
        cells[col(c['@_r'], j)] =
          type === 's'
            ? (shared[Number(value)] ?? '')
            : type === 'inlineStr'
              ? xmlText(c.is)
              : type === 'b'
                ? value === '1'
                  ? 'TRUE'
                  : 'FALSE'
                : value
      })
      return { row: Number(row['@_r']) || i + 1, cells: Array.from({ length: cells.length }, (_, j) => cells[j] ?? '') }
    })
    output.push(...tableSegments(String(sheet['@_name'] ?? 'Sheet'), rows))
  }
  return output
}
