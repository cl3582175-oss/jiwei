import { test, expect } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchRagApp } from './fixtures/ragApp'
import { makeScanPdf, scanImage } from './fixtures/makeScanPdf'

test('PDF rasterization works in an actual DOM-less Electron utility process', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rag-pdf-runtime-'))
  const path = join(directory, 'synthetic.pdf')
  writeFileSync(
    path,
    makeScanPdf(scanImage(['合成扫描内容']), {
      caption: 'Table 1. Synthetic',
      rows: [
        ['Name', 'Value'],
        ['A', '2']
      ]
    })
  )
  const app = await launchRagApp(directory)
  try {
    const result = await app.evaluate(
      async ({ app, utilityProcess }, { path }) => {
        const worker = utilityProcess.fork(`${app.getAppPath()}/out/main/worker.js`)
        try {
          return await new Promise<{ ok: boolean; bytes: number; error?: string }>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('utility-render-timeout')), 20000)
            worker.on('exit', (code) => {
              clearTimeout(timer)
              reject(new Error(`utility-exit-${code}`))
            })
            worker.on('message', (message) => {
              if (message.id !== 'raster') return
              if ('progress' in message) return
              clearTimeout(timer)
              resolve({ ok: message.ok, bytes: message.result?.length ?? 0, error: message.error })
            })
            worker.postMessage({ id: 'raster', task: 'renderPdfPage', payload: { path, page: 1, maxSide: 600 } })
          })
        } finally {
          worker.kill()
        }
      },
      { path }
    )
    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)
    expect(result.bytes).toBeGreaterThan(1000)
  } finally {
    await app.close()
  }
})
