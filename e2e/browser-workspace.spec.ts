import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import type { Server } from 'http'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startSite } from './fixtures/browserPage'
import { navTo } from './fixtures/nav'

// v0.7.2：浏览器独立工作区。从「浏览」进入时浏览器独占整页（没有笔记分类与搜索栏）；
// “记笔记”在浏览器旁新建笔记；笔记栏可放在左 / 右 / 上 / 下，可拖动大小，都会记住；网页原生视图始终贴合浏览器区域。

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page, server: Server, base = ''
const shots = process.env.SHOTS_DIR
const shot = async (name: string): Promise<void> => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}

test.beforeAll(async () => {
  ;({ server, base } = await startSite())
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-browser-ws-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.evaluate(async () => {
    const n = await window.jiwei.notes.create({ categoryId: null })
    await window.jiwei.notes.update(n.id, { title: '已有笔记：遗忘曲线' })
  })
})
test.afterAll(async () => {
  await app?.close()
  server?.close()
})

/** 原生网页视图与浏览器区域重合 */
async function nativeMatches(): Promise<void> {
  // 菜单关闭后的原生视图冻结有一个渲染过渡，不能在插槽隐藏时读取坐标。
  await expect(page.getByTestId('browser-view')).toBeVisible()
  const slot = (await page.getByTestId('browser-view').boundingBox())!
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0]?.getBounds() ?? null))
    .toEqual({ x: Math.round(slot.x), y: Math.round(slot.y), width: Math.round(slot.width), height: Math.round(slot.height) })
}
const box = async (testId: string) => (await page.getByTestId(testId).boundingBox())!
const side = () => page.getByTestId('browser-workspace').getAttribute('data-side')
async function chooseSide(label: string): Promise<void> {
  await page.getByTestId('browser-note-menu').click()
  await page.getByRole('menuitem', { name: label }).click()
}

test('从「浏览」进入：浏览器独占整页，没有笔记分类与笔记主页', async () => {
  await navTo(page, /^浏览/)
  await expect(page.getByTestId('browser-workspace')).toBeVisible()
  await expect(page.getByTestId('browser-workspace')).toHaveAttribute('data-side', 'none')
  await expect(page.getByPlaceholder('搜索笔记')).toHaveCount(0)
  await expect(page.getByTestId('home-review')).toHaveCount(0)
  await page.getByTestId('browser-start').getByRole('textbox').fill(`${base}/article`)
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => window.jiwei.browser.state().then((s) => !!s.tabs[0]?.url.endsWith('/article') && !s.tabs[0].loading))).toBe(true)
  const view = await box('browser-view')
  const pane = (await page.locator('main').boundingBox())!
  // 浏览器几乎占满内容区（只留面板边距）
  expect(view.width).toBeGreaterThan(pane.width - 40)
  await nativeMatches()
  await shot('ws-browser-only')
})

test('记笔记：在浏览器旁新建笔记，默认在右侧', async () => {
  await page.getByTestId('browser-new-note').click()
  await expect(page.getByTestId('browser-note')).toBeVisible()
  expect(await side()).toBe('right')
  await page.getByTestId('browser-note').getByPlaceholder('笔记标题').fill('边读边记')
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({}).then((l) => l.some((n) => n.title === '边读边记')))).toBe(true)
  const b = await box('browser-view'),
    n = await box('browser-note')
  expect(n.x).toBeGreaterThan(b.x + b.width - 2)
  // 笔记分类与搜索栏仍然不出现
  await expect(page.getByPlaceholder('搜索笔记')).toHaveCount(0)
  await nativeMatches()
  await shot('ws-note-right')
})

test('笔记栏位置：下 / 左 / 上，网页视图跟随；选择会记住', async () => {
  await chooseSide('笔记在下')
  await expect.poll(side).toBe('bottom')
  let b = await box('browser-view'),
    n = await box('browser-note')
  expect(n.y).toBeGreaterThan(b.y + b.height - 2)
  await nativeMatches()
  await shot('ws-note-bottom')

  await chooseSide('笔记在左')
  await expect.poll(side).toBe('left')
  b = await box('browser-view')
  n = await box('browser-note')
  expect(n.x + n.width).toBeLessThan(b.x + 2)
  await nativeMatches()

  await chooseSide('笔记在上')
  await expect.poll(side).toBe('top')
  b = await box('browser-view')
  n = await box('browser-note')
  expect(n.y + n.height).toBeLessThan(b.y + 2)
  await nativeMatches()
  expect(await page.evaluate(() => window.jiwei.settings.get().then((s) => s.browser?.noteSide))).toBe('top')
  await chooseSide('笔记在右')
  await expect.poll(side).toBe('right')
})

test('拖动分隔条调整大小，大小会记住', async () => {
  const before = await box('browser-note')
  const sep = page.locator('[data-testid="browser-workspace"] [role="separator"]').first()
  const s = (await sep.boundingBox())!
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
  await page.mouse.down()
  await page.mouse.move(s.x - 200, s.y + s.height / 2, { steps: 10 })
  await page.mouse.up()
  const after = await box('browser-note')
  expect(after.width).toBeGreaterThan(before.width + 150)
  await expect.poll(() => page.evaluate(() => window.jiwei.settings.get().then((s) => s.browser?.noteSize ?? 0))).toBeGreaterThan(50)
  await nativeMatches()
  // 重新打开后保持
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /^浏览/)
  await page.getByTestId('browser-note-menu').click()
  await page.getByRole('menuitem', { name: '已有笔记：遗忘曲线' }).click()
  await expect(page.getByTestId('browser-note')).toBeVisible()
  expect((await box('browser-note')).width).toBeGreaterThan(before.width + 150)
  await nativeMatches()
})

test('打开已有笔记、关闭笔记栏回到整页浏览器', async () => {
  await expect(page.getByTestId('browser-note').getByPlaceholder('笔记标题')).toHaveValue('已有笔记：遗忘曲线')
  await page.getByTestId('browser-note-menu').click()
  await page.getByRole('menuitem', { name: '关闭笔记栏' }).click()
  await expect(page.getByTestId('browser-workspace')).toHaveAttribute('data-side', 'none')
  await nativeMatches()
})

test('从笔记“在笔记旁打开浏览器”：浏览器 + 这篇笔记；关闭浏览器回到这篇笔记', async () => {
  await navTo(page, /^笔记/)
  await page.getByText('边读边记').first().click()
  await page.getByRole('button', { name: '在笔记旁打开浏览器' }).click()
  await expect(page.getByTestId('browser-workspace')).toBeVisible()
  await expect(page.getByTestId('browser-note').getByPlaceholder('笔记标题')).toHaveValue('边读边记')
  await page.getByTestId('browser-note').getByRole('button', { name: '在笔记旁打开浏览器' }).click()
  await expect(page.getByTestId('browser-workspace')).toHaveCount(0)
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('边读边记')
})

test('窄窗 1000×680：上下布局与左右布局都不溢出', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  await navTo(page, /^浏览/)
  // 关闭浏览器后再从「浏览」进入：独占整页，不带上次的笔记
  await expect(page.getByTestId('browser-workspace')).toHaveAttribute('data-side', 'none')
  await page.getByTestId('browser-new-note').click()
  for (const label of ['笔记在下', '笔记在右']) {
    await chooseSide(label)
    await nativeMatches()
    const overflow = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="browser-workspace"]')!
      return el.scrollWidth - el.clientWidth + (el.scrollHeight - el.clientHeight)
    })
    expect(overflow).toBeLessThanOrEqual(1)
  }
  await shot('ws-narrow')
})
