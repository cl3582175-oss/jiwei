import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { drawingSignals, classifyPageNeeds, OPS } from './pdfTriage'
import { parsePdf } from './parsers'
import { makeMaskPdf } from './__tests__/fixtures/maskPdf'

const area = (fns: number[], args: unknown[][]) => drawingSignals(fns, args, 10000, [0, 0, 100, 100]).imageCover
it('detects a real monochrome ImageMask PDF through the production parser', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jiwei-mask-pdf-'))
  try {
    const path = join(dir, 'monochrome.PDF')
    await writeFile(path, makeMaskPdf())
    const parsed = await parsePdf(path, () => {})
    expect(parsed.segments).toEqual([])
    expect(parsed.pages).toEqual([{ page: 1, need: 'scan' }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
it('counts ordinary images and 1 bit image masks with the same transform', () => {
  for (const op of [83, 85, 86]) expect(area([12, op], [[100, 0, 0, 100, 0, 0], [{}]])).toBe(1)
})
it('accounts for each grouped mask and inline image instance', () => {
  const transforms = [
    [50, 0, 0, 100, 0, 0],
    [50, 0, 0, 100, 50, 0]
  ]
  expect(area([84], [[transforms.map((transform) => ({ transform }))]])).toBe(1)
  expect(area([87], [[{}, transforms.map((transform) => ({ transform }))]])).toBe(1)
})
it('uses repeat scales and positions for ordinary and monochrome images', () => {
  expect(area([88], [['image', 50, 100, [0, 0, 50, 0]]])).toBe(1)
  expect(area([89], [[{}, 50, 0, 0, 100, [0, 0, 50, 0]]])).toBe(1)
})
it('does not double count overlapping decoration or off-page image area', () => {
  expect(area([84], [[Array.from({ length: 10 }, () => ({ transform: [50, 0, 0, 100, 0, 0] }))]])).toBe(0.5)
  expect(area([12, 83], [[100, 0, 0, 100, 90, 0], [{}]])).toBeCloseTo(0.1)
})
it('retains rotated polygon area and clips nested Form images to their BBox', () => {
  expect(area([12, 83], [[50, 50, -50, 50, 50, 0], [{}]])).toBeCloseTo(0.5)
  expect(
    area(
      [12, 74, 83, 75],
      [
        [100, 0, 0, 100, 0, 0],
        [
          [1, 0, 0, 1, 0, 0],
          [0, 0, 0.5, 1]
        ],
        [{}],
        []
      ]
    )
  ).toBeCloseTo(0.5)
})
it('keeps blank pages, solid-color fills and native text out of the scan branch', () => {
  expect(area([90], [[]])).toBe(0)
  expect(classifyPageNeeds({ chars: 0, imageCover: 0, paths: 0, lines: [] })).toEqual([])
  expect(classifyPageNeeds({ chars: 500, imageCover: 1, paths: 0, lines: ['Native body'] })).toEqual([])
})
it('keeps the supported operator contract aligned with the installed PDF.js', async () => {
  const { OPS: actual } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  for (const [name, value] of Object.entries(OPS)) expect(value).toBe(actual[name as keyof typeof actual])
  expect(OPS).toMatchObject({
    paintImageMaskXObject: 83,
    paintImageMaskXObjectGroup: 84,
    paintInlineImageXObjectGroup: 87,
    paintImageMaskXObjectRepeat: 89
  })
})
