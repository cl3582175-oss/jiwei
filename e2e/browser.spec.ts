import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import type { Server } from 'http'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clickInPage as clickOf, inPage as inPageOf, pageAction as actionOf, startSite } from './fixtures/browserPage'

// 内置浏览器（v0.6.0）：打开网页、相关笔记旁注、网页中的选区浮条（真实鼠标点击）→ 存为资料 → 高亮 / 批注 / 就地提问，
// 弹出层盖住网页时暂停显示、下载自动导入资料库、敏感页面关闭 AI、AI 面板带上当前网页。
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let server: Server
let base = ''
const shots = process.env.SHOTS_DIR
const downloads = mkdtempSync(join(tmpdir(), 'jiwei-e2e-dl-'))

test.beforeAll(async () => {
  ;({ server, base } = await startSite())
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-browser-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '', JIWEI_DOWNLOAD_DIR: downloads }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
  server?.close()
})

const inPage = <T,>(code: string): Promise<T> => inPageOf<T>(app, code)
const clickInPage = (x: number, y: number): Promise<void> => clickOf(app, x, y)
const pageAction = (text: string, action: string): Promise<void> => actionOf(app, text, action)

const tabs = () => page.evaluate(() => window.jiwei.browser.state())

test('a note to relate to; the browser opens beside it with a start page', async () => {
  test.setTimeout(300_000)
  await page.evaluate(() => window.jiwei.embedding.installLocal())
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('间隔重复')
  await page.keyboard.press('Enter')
  await page.keyboard.type('在快要遗忘的时候复习，复习间隔逐渐拉长，记忆保持得更久。')
  await expect
    .poll(async () => {
      const s = await page.evaluate(() => window.jiwei.embedding.status())
      return s.total > 0 && s.indexed === s.total
    }, { timeout: 60_000 })
    .toBe(true)

  await page.getByRole('button', { name: '在笔记旁打开浏览器' }).click()
  await expect(page.getByTestId('browser-pane')).toBeVisible()
  await expect(page.getByTestId('browser-start')).toBeVisible()
  await page.getByTestId('browser-start').getByRole('textbox').fill(`${base}/article`)
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await tabs()).tabs[0]?.title).toBe('间隔重复的原理')
  await expect(page.getByRole('textbox', { name: '地址栏' })).toHaveValue(`${base}/article`)
  // 笔记仍在右栏
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('间隔重复')
})

test('related notes are suggested from local vectors', async () => {
  await expect(page.getByTestId('browser-related')).toContainText('间隔重复', { timeout: 15_000 })
  if (shots) await page.screenshot({ path: join(shots, '200-browser.png') })
})

test('in-page toolbar: highlight saves the page as a source and paints the highlight', async () => {
  await pageAction('让记忆保持得更久', 'highlighting')
  await expect.poll(async () => (await tabs()).tabs[0]?.sourceId, { timeout: 10_000 }).toBeTruthy()
  const sourceId = (await tabs()).tabs[0].sourceId!
  await expect.poll(() => page.evaluate((id) => window.jiwei.annotations.list('source', id).then((l) => l.length), sourceId)).toBe(1)
  const [a] = await page.evaluate((id) => window.jiwei.annotations.list('source', id), sourceId)
  expect(a.selector.quote).toBe('让记忆保持得更久')
  expect(a.selector.prefix).toContain('复习，')
  // 网页上画出高亮（CSS Custom Highlight，不改动网页 DOM）
  await expect.poll(() => inPage<number>(`CSS.highlights.get('jw-yellow')?.size ?? 0`)).toBe(1)
  // 资料：网页快照分段，进入知识库
  await expect.poll(() => page.evaluate((id) => window.jiwei.segments.list(id).then((s) => s.map((x) => x.text).join('')), sourceId)).toContain('提取练习')
  await expect(page.getByRole('button', { name: '已存为资料' })).toBeVisible()
})

test('comment from the page opens the annotation card beside the browser', async () => {
  await pageAction('比反复重读更有效', 'commenting')
  const card = page.getByTestId('annotation-card')
  await expect(card).toBeVisible()
  const [cb, vb] = await Promise.all([card.boundingBox(), page.getByTestId('browser-view').boundingBox()])
  expect(cb!.x).toBeGreaterThanOrEqual(vb!.x + vb!.width - 1)
  await card.getByRole('textbox').fill('考前用这个方法')
  await page.keyboard.press('ControlOrMeta+Enter')
  const sourceId = (await tabs()).tabs[0].sourceId!
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.annotations.list('source', id).then((l) => l.find((x) => x.body)?.body), sourceId))
    .toBe('考前用这个方法')
  // 网页上的高亮随之更新
  await expect.poll(() => inPage<number>(`CSS.highlights.get('jw-yellow')?.size ?? 0`)).toBe(2)
  // 截取网页视图本身（Playwright 的截图不含原生视图）
  if (shots) {
    const png = await app.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http://127.0.0.1'))!
      return (await wc.capturePage()).toPNG().toString('base64')
    })
    writeFileSync(join(shots, '202-browser-view.png'), Buffer.from(png, 'base64'))
  }
})

test('ask AI from the page: the answer card docks beside the browser; overlays freeze the page', async () => {
  await pageAction('提取练习', 'ask')
  const card = page.getByRole('dialog', { name: '就地答复' })
  await expect(card).toBeVisible()
  const [cb, vb] = await Promise.all([card.boundingBox(), page.getByTestId('browser-view').boundingBox()])
  expect(cb!.x).toBeGreaterThanOrEqual(vb!.x + vb!.width - 1)
  if (shots) await page.screenshot({ path: join(shots, '201-browser-ask.png') })
  await page.keyboard.press('Escape')
  // 命令面板盖住网页：网页换成截图，关闭后恢复
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByTestId('browser-view').locator('img')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('browser-view').locator('img')).toHaveCount(0)
})

test('the AI panel sees the current page', async () => {
  await page.keyboard.press('ControlOrMeta+j')
  await expect(page.getByRole('complementary', { name: /AI/ })).toContainText('间隔重复的原理')
  await page.keyboard.press('ControlOrMeta+j')
})

test('downloads are imported into the library', async () => {
  const r = await inPage<{ x: number; y: number }>(`(() => { const b = document.getElementById('dl').getBoundingClientRect(); return { x: b.left + 5, y: b.top + 5 } })()`)
  await clickInPage(r.x, r.y)
  await expect(page.getByText('已下载并导入资料库：lecture.pdf')).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => page.evaluate(() => window.jiwei.sources.list({}).then((s) => s.map((x) => x.title)))).toContain('lecture')
})

test('sensitive pages turn AI off: no toolbar, cannot be saved', async () => {
  await page.getByRole('textbox', { name: '地址栏' }).fill(`${base}/login`)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('ai-off')).toBeVisible({ timeout: 10_000 })
  await inPage(`(() => {
    const n = document.querySelector('p').firstChild
    const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 6)
    getSelection().removeAllRanges(); getSelection().addRange(r)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })()`)
  await page.waitForTimeout(500)
  expect(await inPage<string | null>(`document.querySelector('jiwei-toolbar')?.getAttribute('data-buttons') ?? null`)).toBeNull()
  await expect(page.evaluate(() => window.jiwei.browser.saveSource(null))).rejects.toThrow(/不发送给 AI/)
  // 浏览器中的网页不能调用积微的接口（只有约定的内容脚本消息）
  const forbidden = await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('/login'))!
    return wc.executeJavaScript(`typeof window.jiwei === 'undefined' && typeof window.require === 'undefined'`)
  })
  expect(forbidden).toBe(true)
})

test('closing the last tab closes the browser', async () => {
  await page.getByRole('button', { name: /关闭标签页/ }).click()
  await expect(page.getByTestId('browser-pane')).toHaveCount(0)
  expect((await tabs()).tabs).toHaveLength(0)
})
