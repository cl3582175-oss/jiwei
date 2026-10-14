import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, it } from 'vitest'
import { PdfBinaryDataFactory } from './pdfAssets'
it('loads PDF binary assets with filesystem I/O, without DOM globals or path traversal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rag-pdf-assets-'))
  try {
    await writeFile(join(dir, 'asset.wasm'), Buffer.from([0, 97, 115, 109]))
    const factory = new PdfBinaryDataFactory({ wasmUrl: dir })
    expect(await factory.fetch({ kind: 'wasmUrl', filename: 'asset.wasm' })).toEqual(new Uint8Array([0, 97, 115, 109]))
    await expect(factory.fetch({ kind: 'wasmUrl', filename: '../other' })).rejects.toThrow()
    await expect(factory.fetch({ kind: 'unknown', filename: 'asset.wasm' })).rejects.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
