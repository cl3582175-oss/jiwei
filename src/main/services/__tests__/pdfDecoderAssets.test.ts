import { describe, expect, it } from 'vitest'
import { pdfDecoderResponse } from '../pdfDecoderAssets'

describe('PDF viewer decoder resources', () => {
  it('serves the bundled CCITT/JBIG2 wasm with its binary MIME type', async () => {
    const response = await pdfDecoderResponse('/wasm/jbig2.wasm')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/wasm')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const bytes = new Uint8Array(await response.arrayBuffer())
    expect([...bytes.slice(0, 4)]).toEqual([0, 97, 115, 109])
    expect(bytes.length).toBeGreaterThan(1000)
  })

  it('serves the shipped JavaScript fallback and the other image codecs', async () => {
    for (const filename of ['jbig2_nowasm_fallback.js', 'openjpeg_nowasm_fallback.js', 'openjpeg.wasm', 'qcms_bg.wasm']) {
      const response = await pdfDecoderResponse(`/wasm/${filename}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Type')).toBe(filename.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8')
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000)
    }
  })

  it.each([
    '/wasm/../../package.json',
    '/wasm/%2e%2e%2fpackage.json',
    '/wasm/../jbig2.wasm',
    '/wasm/jbig2.wasm/extra',
    '/wasm/other.wasm',
    '/jbig2.wasm',
    '/wasm/quickjs-eval.js'
  ])('rejects files outside the image decoder allowlist: %s', async (path) => {
    expect((await pdfDecoderResponse(path)).status).toBe(404)
  })
})
