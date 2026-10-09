import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createCanvas } from '@napi-rs/canvas'
import { makeImagePdf } from './fixtures/makeScanPdf'

// 云端看图模型的文档识别（真实模型）：插图解读、表格还原。
// 用真实教材中的页面（不随仓库分发）：PMBOK 第 8 版中文预览的图 1-2、图 2-7、表 2-1。
// 运行：JIWEI_IMPORT_PROVIDERS_FROM=<应用数据库路径> JIWEI_PMBOK=<PDF 路径> npx playwright test e2e/recognize-live.spec.ts
const providers = process.env.JIWEI_IMPORT_PROVIDERS_FROM
const pmbok = process.env.JIWEI_PMBOK
test.skip(!providers || !pmbok, '需要 JIWEI_IMPORT_PROVIDERS_FROM 与 JIWEI_PMBOK')
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page

/** 在测试进程中把教材的某页画成 JPEG */
async function renderPage(n: number): Promise<{ jpeg: Buffer; w: number; h: number }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(pmbok!)), verbosity: 0 })
  const doc = await task.promise
  const p = await doc.getPage(n)
  const vp = p.getViewport({ scale: 1.5 })
  const c = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height))
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  await p.render({ canvas: c, canvasContext: ctx, viewport: vp } as unknown as Parameters<typeof p.render>[0]).promise
  await task.destroy()
  return { jpeg: c.toBuffer('image/jpeg', 88), w: c.width, h: c.height }
}

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-ocr-live-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

test('cloud vision explains figures and rebuilds tables without inventing content', async () => {
  test.setTimeout(600_000)
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...s.ai, recognition: { mode: 'cloud', providerId: null, model: null, auto: true, figures: true } } })
  })
  const [f12, f27, t21] = await Promise.all([renderPage(34), renderPage(53), renderPage(45)])
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-ocr-live-'))
  const file = join(dir, 'PMBOK 节选.pdf')
  // 文字层只放英文标题（内置字体不含中文），足以触发分流
  writeFileSync(
    file,
    makeImagePdf([
      { ...f12, text: ['Figure 1-2. Portfolio, programs, projects and operations', 'See the figure above for the framework of the organization.'] },
      { ...f27, text: ['Figure 2-7. Project management team competencies', 'The competencies are described in the text of this page.'] },
      { ...t21, text: ['Table 2-1. Effects of organizational structure on projects', 'See the table above for each structure type.'] }
    ])
  )
  const res = await page.evaluate((p) => window.jiwei.sources.importPaths([p]), file)
  const id = res.imported[0].id
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.recognition.source(id), id), { timeout: 540_000, intervals: [3000] })
    .toMatchObject({ needs: { scan: 0, table: 1, figure: 2 }, done: 3, running: false })
  const segs = await page.evaluate((id) => window.jiwei.segments.list(id), id)
  const figures = segs.filter((s) => s.kind === 'ocr:figure').map((s) => s.text)
  const table = segs.filter((s) => s.kind === 'ocr:table').map((s) => s.text).join('\n')
  console.log('--- 图解 ---\n' + figures.join('\n\n') + '\n--- 表格 ---\n' + table)
  writeFileSync(join(dir, 'result.md'), figures.join('\n\n') + '\n\n' + table)
  console.log('saved', join(dir, 'result.md'))

  expect(figures).toHaveLength(2)
  for (const f of figures) expect(f.startsWith('［图解］')).toBe(true)
  // 图 1-2：层级（外部环境 ⊃ 内部环境 ⊃ 价值交付系统 ⊃ 项目组合 ⊃ 项目集 ⊃ 项目），不应编造“项目组合B”
  expect(figures[0]).toMatch(/项目组合/)
  expect(figures[0]).toMatch(/项目集/)
  expect(figures[0]).not.toMatch(/项目组合\s*B/)
  // 图 2-7：三种能力围绕“结果”，外圈是社会责任
  expect(figures[1]).toMatch(/业务敏锐度/)
  expect(figures[1]).toMatch(/社会责任/)
  // 表 2-1：逐格还原
  expect(table).toMatch(/\|\s*矩阵型[—-]+弱矩阵\s*\|\s*职位职能\s*\|\s*低\s*\|/)
})
