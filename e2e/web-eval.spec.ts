import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { WEB_EVAL } from './fixtures/webEval'
import { isolateEmbeddingCache } from './fixtures/embeddingCache'
import type { WebEvalReport } from './fixtures/webEvalRunner'

test.skip(process.env.JIWEI_EVAL !== '1', '设置JIWEI_EVAL=1运行本地联网评分校准；不进入受控回归')

test('calibrate web coverage, gold passage recall and conflict allocation with local vectors', async () => {
  test.setTimeout(900_000)
  expect(WEB_EVAL).toHaveLength(30)
  expect(new Set(WEB_EVAL.map((sample) => sample.id)).size).toBe(30)
  expect(WEB_EVAL.filter((sample) => sample.lang === 'zh')).toHaveLength(20)
  expect(WEB_EVAL.filter((sample) => sample.lang === 'en')).toHaveLength(10)
  for (const kind of ['A', 'B', 'C']) expect(WEB_EVAL.filter((sample) => sample.kind === kind)).toHaveLength(10)
  for (const sample of WEB_EVAL) {
    expect(sample.notes.length).toBeGreaterThanOrEqual(2)
    expect(sample.pages.length).toBeGreaterThanOrEqual(2)
    expect(sample.pages.length).toBeLessThanOrEqual(3)
    expect(sample.pages.flatMap((page) => page.paragraphs).filter((p) => p.gold)).toHaveLength(1)
  }
  const corpusSha256 = createHash('sha256')
    .update(readFileSync(resolve('e2e/fixtures/webEval.ts')))
    .digest('hex')
  const bundle = test.info().outputPath('web-eval-runner.cjs')
  await build({
    entryPoints: ['e2e/fixtures/webEvalRunner.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    alias: { '@shared': resolve('src/shared') }
  })
  const data = mkdtempSync(resolve(tmpdir(), 'jiwei-web-eval-'))
  const application = await electron.launch({
    args: ['.', `--user-data-dir=${data}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  try {
    const page = await application.firstWindow()
    await page.waitForSelector('nav')
    await isolateEmbeddingCache(application)
    const report = (await application.evaluate(async ({ app }, bundle) => {
      const require = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json')
      return require(bundle).runWebEval()
    }, bundle)) as WebEvalReport
    const result = { ...report, corpusSha256 }
    writeFileSync(test.info().outputPath('web-eval.json'), JSON.stringify(result, null, 2))
    if (process.env.EVAL_OUT) writeFileSync(process.env.EVAL_OUT, JSON.stringify(result, null, 2))
    await test.info().attach('Local web calibration', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
    console.log(
      JSON.stringify(
        {
          corpusSha256,
          coverage: report.coverageTable.map(({ perCase: _perCase, ...row }) => row),
          floor: report.floorTable.map(({ perCase: _perCase, ...row }) => row),
          selected: report.selected,
          embeddingMs: report.embeddingMs,
          totalMs: report.totalMs
        },
        null,
        2
      )
    )
    expect(report.cases).toBe(30)
    expect(report.selected.FLOOR).not.toBeNull()
    expect(report.floorTable.find((row) => row.floor === report.selected.FLOOR)!.goldRecallAt6).toBeGreaterThanOrEqual(0.9)
    expect(report.readerDiagnostics.filter((row) => row.goldSelected).length / report.cases).toBeGreaterThanOrEqual(0.9)
    const conflict = report.floorTable.find((row) => row.floor === report.selected.FLOOR)!
    expect(conflict.conflictsBoth).toBe(conflict.conflictsTotal)
  } finally {
    await application.close()
  }
})
