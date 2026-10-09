import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { makeScanPdf, scanImage } from './fixtures/makeScanPdf'

// 文档识别（v0.5.2）：按页分流 → 识别扫描页与表格 → 并入资料分段、进入知识库。
// 默认只测分流、状态条与设置；设置 JIWEI_OCR=1 时下载并运行本地识别模型（LightOnOCR-2-1B，约 1.1 GB）。
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
const shots = process.env.SHOTS_DIR
const dir = mkdtempSync(join(tmpdir(), 'jiwei-ocr-src-'))
const SCAN = ['第三章 间隔重复', '间隔重复是在即将遗忘时复习，', '让记忆保持得更久。复习间隔应', '随着掌握程度逐渐拉长。']
const TABLE = {
  caption: 'Table 3-1. Study methods compared',
  rows: [
    ['Method', 'Effort', 'Long-term effect'],
    ['Rereading', 'Low', 'Weak'],
    ['Spaced repetition', 'Medium', 'Strong'],
    ['Retrieval practice', 'High', 'Strong']
  ]
}
let pdfId = ''

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-ocr-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '', JIWEI_OCR_IDLE_MS: '4000' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

const setRecognition = (patch: Record<string, unknown>) =>
  page.evaluate(async (patch) => {
    const s = await window.jiwei.settings.get()
    const rc = s.ai.recognition ?? { mode: 'local' as const, providerId: null, model: null, auto: true, figures: false }
    await window.jiwei.settings.set({ ai: { ...s.ai, recognition: { ...rc, ...patch } } })
  }, patch)

async function openSource(title: string): Promise<void> {
  await page.reload()
  await page.waitForSelector('nav')
  await page.getByRole('button', { name: /资料库/ }).click()
  await page.getByText(title, { exact: true }).dblclick()
}

test('PDF pages are triaged: scanned page and table page need recognition', async () => {
  // 没有能看图的模型：云端识别不可用，只登记待识别的页
  await setRecognition({ mode: 'cloud' })
  const file = join(dir, '学习方法（扫描）.pdf')
  writeFileSync(file, makeScanPdf(scanImage(SCAN), TABLE))
  const res = await page.evaluate((p) => window.jiwei.sources.importPaths([p]), file)
  pdfId = res.imported[0].id
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.recognition.source(id).then((r) => r.needs), pdfId), { timeout: 30_000 })
    .toEqual({ scan: 1, table: 1, figure: 0 })
  const r = await page.evaluate((id) => window.jiwei.recognition.source(id), pdfId)
  expect(r.engine).toBe('no-vision-model')
  // 文字层：扫描页没有文字，表格页的单元格被拆成零散的行
  const segs = await page.evaluate((id) => window.jiwei.segments.list(id), pdfId)
  expect(segs.map((s) => s.text).join('\n')).not.toContain('间隔重复')

  await openSource('学习方法（扫描）')
  await expect(page.getByTestId('recognition-bar')).toContainText('云端识别需要能看图的模型')
})

test('settings: engine choice, local model download, figures', async () => {
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('button', { name: 'AI 模型' }).click()
  const sec = page.getByTestId('recognition-settings')
  await sec.scrollIntoViewIfNeeded()
  await expect(sec.getByRole('radio', { name: '云端看图模型' })).toHaveAttribute('aria-checked', 'true')
  await sec.getByRole('radio', { name: /本地/ }).click()
  await expect(sec).toContainText(/识别模型已就绪|下载识别模型/)
  await expect(sec.getByRole('switch', { name: '导入后自动识别' })).toBeChecked()
  await expect(sec.getByRole('switch', { name: /解读插图/ })).not.toBeChecked()
  if (shots) await sec.screenshot({ path: join(shots, '180-recognition-settings.png') })
  await page.keyboard.press('Escape')
  const st = await page.evaluate(() => window.jiwei.recognition.status())
  if (st.state !== 'ready') {
    // 未下载时：状态条提示下载
    await expect(page.getByTestId('recognition-bar')).toContainText('有 2 页需要识别（1 页扫描、1 页表格）')
    await expect(page.getByTestId('recognition-bar').getByRole('button', { name: /下载识别模型/ })).toBeVisible()
  }
})

test.describe('local recognition model', () => {
  test.skip(!process.env.JIWEI_OCR, '设置 JIWEI_OCR=1 运行本地识别模型（首次下载约 1.1 GB）')

  test('downloads the model (mirrors + sha256)', async () => {
    test.setTimeout(1_800_000)
    await page.evaluate(() => window.jiwei.recognition.install())
    await expect
      .poll(() => page.evaluate(() => window.jiwei.recognition.status().then((s) => s.state)), { timeout: 1_700_000, intervals: [3000] })
      .toBe('ready')
  })

  test('scanned page and table are recognized into the knowledge base', async () => {
    test.setTimeout(300_000)
    // 模型就绪且开启自动识别：设置为本地后自动排队
    await expect
      .poll(() => page.evaluate((id) => window.jiwei.recognition.source(id), pdfId), { timeout: 240_000, intervals: [2000] })
      .toMatchObject({ total: 2, done: 2, failed: 0, running: false })
    const segs = await page.evaluate((id) => window.jiwei.segments.list(id), pdfId)
    const scan = segs.find((s) => s.kind === 'ocr:scan')!
    expect(scan.text).toContain('间隔重复是在即将遗忘时复习')
    expect(JSON.stringify(scan.locator)).toContain('page=1')
    const table = segs.find((s) => s.kind === 'ocr:table')!
    expect(table.text).toMatch(/Table 3-1/)
    expect(table.text).toMatch(/\|\s*Spaced repetition\s*\|\s*Medium\s*\|\s*Strong\s*\|/)
    // 识别分段排在第 2 页文字之后
    expect(segs.findIndex((s) => s.kind === 'ocr:table')).toBeGreaterThan(segs.findIndex((s) => s.text.includes('Chapter 3')))
    // 全文检索可以找到扫描页的内容
    const hits = await page.evaluate(() => window.jiwei.segments.search('即将遗忘'))
    expect(hits.some((h) => h.sourceId === pdfId)).toBe(true)
    await expect(page.getByTestId('recognition-bar')).toContainText('已识别 2 页（1 页扫描、1 页表格）')
    if (shots) await page.screenshot({ path: join(shots, '181-recognized.png') })
  })

  test('image sources are recognized and the text is shown under the image', async () => {
    test.setTimeout(240_000)
    const png = join(dir, '白板照片.jpg')
    writeFileSync(png, scanImage(['提取练习：合上书，', '自己回忆刚学过的内容。']))
    const res = await page.evaluate((p) => window.jiwei.sources.importPaths([p]), png)
    const id = res.imported[0].id
    await expect
      .poll(() => page.evaluate((id) => window.jiwei.segments.list(id).then((s) => s.map((x) => x.text).join('')), id), { timeout: 200_000 })
      .toContain('合上书')
    await openSource('白板照片')
    // 小模型偶有错字（实测曾把“刚学过”识别为“课文过”），只检查主要内容
    await expect(page.getByRole('region', { name: '识别出的文字' })).toContainText('自己回忆')
    if (shots) await page.screenshot({ path: join(shots, '182-image-text.png') })
  })

  test('the local model is not resident: it exits when idle', async () => {
    await expect.poll(() => page.evaluate(() => window.jiwei.recognition.status().then((s) => s.running)), { timeout: 30_000 }).toBe(false)
  })
})
