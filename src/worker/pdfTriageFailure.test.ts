import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { makeMaskPdf } from '../../e2e/fixtures/makeScanPdf'
vi.mock('./pdfTriage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pdfTriage')>()),
  drawingSignals: () => {
    throw new Error('unsupported image transform')
  }
}))
import { parsePdf } from './parsers'
it('persists a page detection failure instead of reporting an empty successful document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jiwei-triage-failure-'))
  try {
    const path = join(dir, 'mask.pdf')
    await writeFile(path, makeMaskPdf())
    const result = await parsePdf(path, () => {})
    expect(result.pages).toEqual([{ page: 1, need: 'scan', error: 'Page detection failed: unsupported image transform' }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
