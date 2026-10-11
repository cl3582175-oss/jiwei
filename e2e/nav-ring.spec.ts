import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { currentNav, navTo } from './fixtures/nav'

// 导航浮卡（v0.7.4）：导航栏高度固定；悬停组图标，组图标向右延伸成玻璃浮卡列出二级入口；点组图标直达上次页面；
// 当前位置以组图标右下角的小标显示；Esc / 移开收起；键盘可操作；靠近窗口底部时浮卡上移不被切掉。

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page
const shots = process.env.SHOTS_DIR
const shot = async (name: string): Promise<void> => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}
const rail = () => page.getByTestId('nav-rail')
const ring = () => page.getByTestId('nav-ring')
const railHeight = async () =>
  rail().evaluate((el) => [...el.querySelectorAll('[data-testid^="nav-group-"]')].reduce((h, g) => h + g.getBoundingClientRect().height, 0))

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-nav-ring-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.evaluate(() => window.jiwei.inbox.create({ kind: 'text', text: '待整理的一条', origin: {} }))
})
test.afterAll(async () => {
  await app?.close()
})

test('首次使用有一次轻提示，几秒后淡出；导航栏只有组图标，没有展开的二级按钮', async () => {
  await expect(page.getByTestId('nav-ring-hint')).toBeVisible()
  await shot('ring-hint')
  // 停留约 3.5 秒后淡出，然后移除
  await expect(page.getByTestId('nav-ring-hint')).toHaveCount(0, { timeout: 6000 })
  await expect(rail().getByRole('button', { name: /^资料库/ })).toHaveCount(0)
  await expect(rail().getByRole('button', { name: /^笔记/ })).toHaveCount(0)
})

test('悬停组图标：浮卡与图标连成一体，按行列出入口，带快捷键与角标', async () => {
  const g = rail().getByRole('button', { name: /^收集/ })
  await g.hover()
  await expect(ring()).toBeVisible()
  const items = ring().getByRole('menuitem')
  await expect(items).toHaveCount(4)
  await expect(items.nth(0)).toContainText('收件箱')
  await expect(items.nth(0)).toContainText('1')
  await expect(items.nth(1)).toContainText('资料库')
  await expect(items.nth(1)).toContainText('⌘2')
  await page.waitForTimeout(300)
  // 浮卡紧贴组图标右侧、顶端对齐；入口从上到下排列
  const gb = (await g.boundingBox())!,
    card = (await page.getByTestId('nav-flyout').boundingBox())!
  expect(Math.abs(card.x - (gb.x + gb.width))).toBeLessThan(2)
  expect(Math.abs(card.y - gb.y)).toBeLessThan(2)
  await expect(g).toHaveAttribute('aria-expanded', 'true')
  let y = 0
  for (let i = 0; i < 4; i++) {
    const r = (await items.nth(i).boundingBox())!
    expect(r.y).toBeGreaterThan(y)
    y = r.y
  }
  expect(await page.getByTestId('nav-flyout').evaluate((el) => getComputedStyle(el).backdropFilter)).toContain('blur')
  await shot('ring-collect')
})

test('点浮卡入口跳转；组图标右下角显示当前位置；导航栏高度不变', async () => {
  const before = await railHeight()
  await ring().getByRole('menuitem', { name: '资料库' }).click()
  await expect(ring()).toHaveCount(0)
  await expect(currentNav(page, '收集', '资料库')).toBeVisible()
  await expect(rail().getByTestId('nav-group-collect').getByTestId('nav-sub')).toBeVisible()
  expect(await railHeight()).toBe(before)
  // 再次展开：当前项有标记
  await rail().getByRole('button', { name: /^收集/ }).hover()
  await expect(ring().getByRole('menuitem', { name: '资料库' })).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Escape')
  await expect(ring()).toHaveCount(0)
})

test('点组图标直达上次页面，不需要展开', async () => {
  await navTo(page, /^图谱/)
  await page.keyboard.press('ControlOrMeta+9')
  await page.mouse.move(800, 400)
  await rail().getByRole('button', { name: /^学习/ }).click()
  await expect(currentNav(page, '学习', '图谱')).toBeVisible()
  await expect(ring()).toHaveCount(0)
})

test('移开鼠标收起；从组图标移到浮卡不会收起', async () => {
  const g = rail().getByRole('button', { name: /^计划/ })
  await g.hover()
  await expect(ring()).toBeVisible()
  await expect(ring().getByRole('menuitem')).toHaveCount(3)
  await expect(ring().getByRole('menuitem', { name: '日历', exact: true })).toBeVisible()
  await expect(ring().getByRole('menuitem', { name: '方向', exact: true })).toBeVisible()
  await expect(ring().getByRole('menuitem', { name: /^复盘(?:\s|$)/ })).toBeVisible()
  await page.waitForTimeout(300)
  await shot('ring-plan')
  const b = (await ring().getByRole('menuitem', { name: '复盘' }).boundingBox())!
  await page.mouse.move(b.x + 10, b.y + b.height / 2, { steps: 12 })
  await page.waitForTimeout(400)
  await expect(ring()).toBeVisible()
  await page.mouse.move(1100, 600, { steps: 4 })
  await expect(ring()).toHaveCount(0)
})

test('键盘：→ 展开，↓ 选择，回车进入；数字键直达', async () => {
  const g = rail().getByRole('button', { name: /^学习/ })
  await page.mouse.move(1100, 600)
  await g.focus()
  await page.keyboard.press('ArrowRight')
  await expect(ring()).toBeVisible()
  await page.keyboard.press('2')
  await expect(ring()).toHaveCount(0)
  await expect(currentNav(page, '学习', '复习')).toBeVisible()
  await g.focus()
  await page.keyboard.press('ArrowRight')
  await expect(ring()).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(ring()).toHaveCount(0)
  await expect(currentNav(page, '学习', '费曼')).toBeVisible()
})

test('靠近窗口底部时浮卡上移，不被切掉；深色截图', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640))
  await page.evaluate(() => window.jiwei.settings.set({ theme: 'dark' }))
  await page.mouse.move(900, 300)
  await rail().getByRole('button', { name: /^计划/ }).hover()
  await expect(ring()).toBeVisible()
  await page.waitForTimeout(450)
  const h = await page.evaluate(() => innerHeight)
  for (const it of await ring().getByRole('menuitem').all()) {
    const b = (await it.boundingBox())!
    expect(b.y).toBeGreaterThanOrEqual(0)
    expect(b.y + b.height).toBeLessThanOrEqual(h)
  }
  await shot('ring-dark-narrow')
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.jiwei.settings.set({ theme: 'system' }))
})

test('浮卡盖住内置浏览器时，网页暂时换成截图，不会挡住半环', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await navTo(page, /^浏览/)
  await expect(page.getByTestId('browser-workspace')).toBeVisible()
  await page.getByTestId('browser-start').getByRole('textbox').fill('data:text/html,<h1>hi</h1>')
  await rail().getByRole('button', { name: /^学习/ }).hover()
  await expect(ring()).toBeVisible()
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0]?.getVisible() ?? false))
    .toBe(false)
  await page.keyboard.press('Escape')
})
