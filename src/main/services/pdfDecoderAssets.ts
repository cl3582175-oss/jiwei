import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const decoders = new Set(['jbig2.wasm', 'jbig2_nowasm_fallback.js', 'openjpeg.wasm', 'openjpeg_nowasm_fallback.js', 'qcms_bg.wasm'])

/** Only expose PDF.js's bundled image decoders, never arbitrary package or user files. */
export async function pdfDecoderResponse(pathname: string): Promise<Response> {
  const name = /^\/wasm\/([^/]+)$/.exec(pathname)?.[1]
  if (!name || !decoders.has(name)) return new Response('Not found', { status: 404 })
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  try {
    const bytes = await readFile(join(root, 'wasm', name))
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        // Decoder bytes must follow the installed PDF.js version after an application update.
        'Cache-Control': 'no-store'
      }
    })
  } catch {
    return new Response('PDF decoder unavailable', { status: 503 })
  }
}
