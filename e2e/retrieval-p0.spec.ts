import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { P0_PAGES, P0_PDF_LINES } from './fixtures/retrievalP0'
import { makePdf } from './fixtures/makePdf'

test.skip(process.env.JIWEI_P0 !== '1', 'P0 独立技术验证，不进入受控回归')

test('P0 local extraction, rendering, PDF and 60-paragraph embedding', async () => {
  const info = test.info()
  test.setTimeout(900_000)
  const data = mkdtempSync(join(tmpdir(), 'jiwei-p0-'))
  const output = resolve('.superpowers/sdd/v0.13-web-retrieval')
  mkdirSync(output, { recursive: true })
  const bundle = join(output, 'p0-probe.cjs')
  await build({
    entryPoints: ['e2e/fixtures/retrievalP0Probe.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    alias: { '@shared': resolve('src/shared') }
  })
  const pdf = join(data, 'controlled.pdf')
  writeFileSync(pdf, makePdf([P0_PDF_LINES]))
  const server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(P0_PAGES[req.url ?? ''] ?? 'missing'))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${data}`],
    env: { ...process.env, JIWEI_TEST_NETWORK: '1', JIWEI_SKIP_ONBOARDING: '1', JIWEI_LANG: 'zh-CN', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  try {
    const pages = (await app.evaluate(
      async ({ app }, { bundle, base }) => {
        const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
        return require(bundle).probePages(base)
      },
      { bundle, base }
    )) as Record<string, { direct: { text: string; paragraphs: number; flat: string }; rendered: { text: string; paragraphs: number } }>
    for (const path of ['/article', '/list', '/hidden']) expect(pages[path].direct.paragraphs).toBeGreaterThanOrEqual(5)
    expect(pages['/js'].direct.text).not.toContain('JS_RENDERED_MARKER')
    expect(pages['/js'].rendered.text).toContain('JS_RENDERED_MARKER')
    for (const result of [pages['/hidden'].direct, pages['/hidden'].rendered])
      expect(result.text).not.toMatch(/HIDDEN_MARKER|ARIA_MARKER|INLINE_MARKER|VISIBILITY_MARKER|ZERO_MARKER|SCRIPT_MARKER/)
    expect(pages.windowsAfter).toBe(0)
    expect(pages['/article'].direct.flat).not.toContain('\n\n')
    const parsed = await app.evaluate(
      async ({ app }, { bundle, pdf }) => {
        const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
        return require(bundle).probePdf(pdf)
      },
      { bundle, pdf }
    )
    expect(parsed.text).toContain('P0 paragraph 0')
    const embedding = await app.evaluate(async ({ app }, bundle) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
      return require(bundle).probeEmbedding()
    }, bundle)
    expect(embedding.count).toBe(60)
    expect(embedding.dim).toBeGreaterThanOrEqual(512)
    const report = { pages, parsed, embedding }
    writeFileSync(join(output, 'p0-reader-embedding.json'), JSON.stringify(report, null, 2))
    await info.attach('P0 evidence', { body: JSON.stringify(report, null, 2), contentType: 'application/json' })
  } finally {
    await app.close()
    await new Promise<void>((r) => server.close(() => r()))
  }
})
