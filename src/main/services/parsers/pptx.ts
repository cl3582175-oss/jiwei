import { elements, openOffice, readXml, relationshipPath, xmlText, type Xml } from './ooxml'
import type { SegmentInput } from '../segments'
import { normalizeExtracted } from '../../lib/textNormalize'

function shapes(root: unknown): Xml[] {
  return elements(root).flatMap((value) => [
    ...(value.txBody ? [value] : []),
    ...Object.entries(value)
      .filter(([k]) => k !== 'txBody' && !k.startsWith('@_'))
      .flatMap(([, child]) => shapes(child))
  ])
}
const paragraphs = (shape: Xml): string =>
  elements((shape.txBody as Xml | undefined)?.p)
    .map(xmlText)
    .filter((t) => t.trim())
    .join('\n')
const placeholder = (shape: Xml): string =>
  String((((shape.nvSpPr as Xml | undefined)?.nvPr as Xml | undefined)?.ph as Xml | undefined)?.['@_type'] ?? '')

export async function parsePptx(path: string): Promise<SegmentInput[]> {
  const zip = await openOffice(path)
  const slides = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => Number(/slide(\d+)/.exec(a)![1]) - Number(/slide(\d+)/.exec(b)![1]))
  if (!slides.length) throw new Error('Invalid pptx presentation')
  const output: SegmentInput[] = []
  for (const [i, slide] of slides.entries()) {
    const all = shapes(await readXml(zip, slide)),
      titles = all.filter((s) => ['title', 'ctrTitle'].includes(placeholder(s))).map(paragraphs),
      body = all.filter((s) => !['title', 'ctrTitle', 'sldNum'].includes(placeholder(s))).map(paragraphs)
    const rels = elements(
      ((await readXml(zip, slide.replace('slides/', 'slides/_rels/') + '.rels')).Relationships as Xml | undefined)?.Relationship
    )
    const notes = rels.find((r) => String(r['@_Type']).endsWith('/notesSlide') && r['@_TargetMode'] !== 'External')
    const noteText = notes
      ? shapes(await readXml(zip, relationshipPath(slide, notes['@_Target'])))
          .filter((s) => !['sldImg', 'sldNum', 'dt', 'ftr', 'hdr'].includes(placeholder(s)))
          .map(paragraphs)
          .filter(Boolean)
          .join('\n')
      : ''
    const text = [
      `第 ${i + 1} 页`,
      ...titles.filter(Boolean).map((t) => `## ${t}`),
      ...body.filter(Boolean),
      ...(noteText ? [`讲者备注：${noteText}`] : [])
    ].join('\n')
    output.push({
      kind: 'slide',
      heading: normalizeExtracted(titles.filter(Boolean).join(' › ')).slice(0, 120),
      text: normalizeExtracted(text),
      locator: { page: i + 1, value: `page=${i + 1}` }
    })
  }
  return output
}
