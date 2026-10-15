import { test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { launchRagApp } from './fixtures/ragApp'
import { navTo } from './fixtures/nav'
import type { RagQuestion } from './fixtures/ragMetrics'

test.skip(process.env.JIWEI_RAG_SMOKE !== '1', '设置外部素材目录后运行真实文件导入冒烟')

test('built application imports legacy Word and a course PDF and finds a two-character term', async () => {
  test.setTimeout(180_000)
  const evalDir = resolve(process.env.JIWEI_RAG_EVAL ?? ''),
    corpus = resolve(process.env.JIWEI_RAG_CORPUS ?? '')
  for (const path of [evalDir, corpus]) {
    const rel = relative(resolve('.'), path)
    if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('真实素材与证据必须放在仓库外')
  }
  const manifest = JSON.parse(readFileSync(join(evalDir, 'manifest.json'), 'utf8')) as { files: { path: string }[] }
  const questions = JSON.parse(readFileSync(join(evalDir, 'questions.json'), 'utf8')) as RagQuestion[]
  const terms = JSON.parse(process.env.JIWEI_RAG_SMOKE_TERMS ?? '[]') as string[]
  expect(terms).toHaveLength(2)
  for (const term of terms) expect(term).toMatch(/^\p{Script=Han}{2}$/u)
  const doc = manifest.files.find((f) => extname(f.path).toLowerCase() === '.doc')
  const pdf = manifest.files.find(
    (f) =>
      extname(f.path).toLowerCase() === '.pdf' &&
      questions.some((q) => q.subtype === 'course' && q.gold?.some((g) => f.path.includes(g.title)))
  )
  expect(doc).toBeTruthy()
  expect(pdf).toBeTruthy()
  const directory = mkdtempSync(join(tmpdir(), 'rag-corpus-smoke-'))
  const old = process.env.JIWEI_TEST_MODEL_CACHE_ROOT
  process.env.JIWEI_TEST_MODEL_CACHE_ROOT = join(directory, 'empty-cache')
  const app = await launchRagApp(directory).finally(() => {
    if (old === undefined) delete process.env.JIWEI_TEST_MODEL_CACHE_ROOT
    else process.env.JIWEI_TEST_MODEL_CACHE_ROOT = old
  })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    await page.evaluate(() => window.jiwei.settings.set({ retrieval: { autoUpgrade: false } }))
    const paths = [doc!, pdf!].map((f) => {
      const path = resolve(corpus, f.path),
        rel = relative(corpus, path)
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('素材路径越界')
      return path
    })
    const imported = await page.evaluate((paths) => window.jiwei.sources.importPaths(paths), paths)
    expect(imported.imported).toHaveLength(2)
    const results = []
    for (const [i, source] of imported.imported.entries()) {
      await expect
        .poll(() => page.evaluate((id) => window.jiwei.segments.list(id).then((s) => s.length), source.id), { timeout: 120_000 })
        .toBeGreaterThan(0)
      const segments = await page.evaluate((id) => window.jiwei.segments.list(id), source.id)
      const term = terms[i]
      const hits = await page.evaluate(
        ({ id, term }) => window.jiwei.knowledge.search(term, { type: 'items', notes: [], sources: [id] }, 8),
        { id: source.id, term: term! }
      )
      results.push({ source, segments: segments.length, term, hits })
      writeFileSync(
        join(evalDir, 'results', `corpus-smoke-${test.info().retry}-${directory.split('/').at(-1)}.json`),
        JSON.stringify({ directory, model: 'none-keywords-only', results }, null, 2)
      )
      expect(hits.some((h) => h.parentId === source.id && (h.text + (h.heading ?? '')).includes(term!))).toBe(true)
    }
    await navTo(page, /资料库/)
    await page.getByText(imported.imported[0].title, { exact: true }).dblclick()
    await expect(page.locator('.source-text')).toBeVisible()
    writeFileSync(
      join(evalDir, 'results', `corpus-smoke-${Date.now()}.json`),
      JSON.stringify({ directory, model: 'none-keywords-only', results }, null, 2)
    )
  } finally {
    await app.close()
  }
})
