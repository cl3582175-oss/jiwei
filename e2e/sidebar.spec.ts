import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'

// 列表栏书脊式收展（v0.7.3）：收起按钮在列表栏标题旁；收起后留书脊（竖排当前位置），悬停窥视、点击固定；
// 右边缘拖宽、拖窄收起；笔记 / 资料库 / 助手各自记住；空间不够自动收起；导航栏上不再有收展按钮。
test.describe.configure({ mode: 'serial' })
const userData = mkdtempSync(join(tmpdir(), 'jiwei-e2e-sb-'))
const shots = process.env.SHOTS_DIR
let app: ElectronApplication, page: Page
const launch = async (): Promise<void> => {
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' } })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
}
const shot = async (name: string): Promise<void> => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}
const bar = (p: string) => page.getByTestId(`sidebar-${p}`)
const mainWidth = () =>
  page
    .locator('.panel')
    .first()
    .evaluate((el) => el.getBoundingClientRect().width)

test.beforeAll(launch)
test.afterAll(async () => {
  await app?.close()
})

test('导航栏上没有收展按钮；收起按钮在列表栏标题旁，收起后留书脊并写着当前位置', async () => {
  await page.evaluate(async () => {
    const c = await window.jiwei.categories.create('note', '考研数学', null)
    const n = await window.jiwei.notes.create({ categoryId: c.id })
    await window.jiwei.notes.update(n.id, { title: '极限的定义' })
  })
  await navTo(page, /^笔记/)
  await expect(page.getByTestId('nav-rail').getByRole('button', { name: /收起列表|展开列表|收起侧栏|展开侧栏/ })).toHaveCount(0)
  await page.getByTestId('sidebar-notes').getByText('考研数学').click()
  const before = await mainWidth()
  await bar('notes').getByTestId('sidebar-toggle').click()
  await expect(bar('notes')).toHaveAttribute('data-collapsed', 'true')
  await expect(bar('notes').getByTestId('sidebar-spine')).toContainText('笔记 · 考研数学')
  await page.waitForTimeout(400)
  expect((await mainWidth()) - before).toBeGreaterThan(260)
  await shot('sb-spine')
})

test('悬停书脊：列表以浮层滑出、不挤动正文；移开自动收回；点图钉固定', async () => {
  const width = await mainWidth()
  await bar('notes').getByTestId('sidebar-spine').hover()
  await expect(bar('notes')).toHaveAttribute('data-peeking', 'true')
  await expect(bar('notes').getByText('极限的定义')).toBeVisible()
  expect(await mainWidth()).toBe(width)
  await page.waitForTimeout(300)
  await shot('sb-peek')
  // 在浮层里选一篇笔记：浮层仍可用
  await bar('notes').getByText('极限的定义').click()
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('极限的定义')
  await page.mouse.move(1000, 500)
  await expect(bar('notes')).toHaveAttribute('data-peeking', 'false')
  // 再次窥视，点图钉固定
  await bar('notes').getByTestId('sidebar-spine').hover()
  await expect(bar('notes')).toHaveAttribute('data-peeking', 'true')
  await bar('notes').getByRole('button', { name: '固定列表' }).click()
  await expect(bar('notes')).toHaveAttribute('data-collapsed', 'false')
})

test('拖动右边缘调整宽度，双击恢复；拖得很窄就收起', async () => {
  // 等展开动画结束再量把手位置
  await expect.poll(async () => Math.round((await bar('notes').boundingBox())!.width)).toBe(300)
  const handle = bar('notes').getByTestId('sidebar-resize')
  const h = (await handle.boundingBox())!
  await page.mouse.move(h.x + h.width / 2, h.y + 300)
  await page.mouse.down()
  await page.mouse.move(h.x + 80, h.y + 300, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => (await bar('notes').boundingBox())!.width).toBeGreaterThan(370)
  await expect.poll(() => page.evaluate(() => window.jiwei.settings.get().then((s) => s.sidebars?.notes?.width ?? 0))).toBeGreaterThan(370)
  await handle.dblclick()
  await expect.poll(async () => Math.round((await bar('notes').boundingBox())!.width)).toBe(300)
  const h2 = (await handle.boundingBox())!
  await page.mouse.move(h2.x + h2.width / 2, h2.y + 300)
  await page.mouse.down()
  await page.mouse.move(h2.x - 220, h2.y + 300, { steps: 6 })
  await page.mouse.up()
  await expect(bar('notes')).toHaveAttribute('data-collapsed', 'true')
  // 收起不丢宽度：⌘\ 展开后仍是原宽度
  await page.keyboard.press('ControlOrMeta+\\')
  await expect(bar('notes')).toHaveAttribute('data-collapsed', 'false')
  await expect.poll(async () => Math.round((await bar('notes').boundingBox())!.width)).toBe(300)
})

test('各页面分别记住：笔记收起不影响资料库与助手', async () => {
  await page.keyboard.press('ControlOrMeta+\\')
  await expect(bar('notes')).toHaveAttribute('data-collapsed', 'true')
  await navTo(page, /资料库/)
  await expect(bar('library')).toHaveAttribute('data-collapsed', 'false')
  await expect(bar('library').getByTestId('sidebar-toggle')).toBeVisible()
  await navTo(page, /积微助手/)
  await expect(bar('chat')).toHaveAttribute('data-collapsed', 'false')
  await page.keyboard.press('ControlOrMeta+\\')
  await expect(bar('chat')).toHaveAttribute('data-collapsed', 'true')
  await expect(bar('chat').getByTestId('sidebar-spine')).toContainText('对话记录')
  // 没有列表栏的页面：⌘\ 不响应，也没有按钮
  await navTo(page, /今日/)
  await page.keyboard.press('ControlOrMeta+\\')
  await expect(page.getByTestId('sidebar-toggle')).toHaveCount(0)
})

test('空间不够时自动收成书脊，空间回来自动展开；手动收起的保持收起', async () => {
  await navTo(page, /资料库/)
  await expect(bar('library')).toHaveAttribute('data-collapsed', 'false')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  await expect(bar('library')).toHaveAttribute('data-collapsed', 'true')
  // 临时展开（不改设置）
  await bar('library').getByTestId('sidebar-spine').click()
  await expect(bar('library')).toHaveAttribute('data-collapsed', 'false')
  await shot('sb-narrow-expanded')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await expect(bar('library')).toHaveAttribute('data-collapsed', 'false')
  expect(await page.evaluate(() => window.jiwei.settings.get().then((s) => s.sidebars?.library?.collapsed ?? false))).toBe(false)
  // 打开资料与笔记并排、窗口较窄：笔记列表自动收起
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-src-'))
  writeFileSync(join(dir, '资料.md'), '# 资料\n\n正文。')
  await page.evaluate((p) => window.jiwei.sources.importPaths([p]), join(dir, '资料.md'))
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /^笔记/)
  await page.keyboard.press('ControlOrMeta+\\')
  await expect(bar('notes')).toHaveAttribute('data-collapsed', 'false')
  await bar('notes').getByText('极限的定义').first().click()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800))
  // 从资料库双击打开：资料在左、当前笔记在右
  await navTo(page, /资料库/)
  await page.locator('.panel').getByText('资料', { exact: true }).first().dblclick()
  await expect(page.locator('.source-text')).toBeVisible()
  await expect(bar('notes')).toHaveAttribute('data-collapsed', 'true')
  await shot('sb-auto-source')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
})

test('重启后保持各页面的收展', async () => {
  await navTo(page, /积微助手/)
  await expect(bar('chat')).toHaveAttribute('data-collapsed', 'true')
  await app.close()
  await launch()
  await navTo(page, /积微助手/)
  await expect(bar('chat')).toHaveAttribute('data-collapsed', 'true')
  await navTo(page, /资料库/)
  await expect(bar('library')).toHaveAttribute('data-collapsed', 'false')
})

test('深色：书脊与浮层', async () => {
  await page.evaluate(() => window.jiwei.settings.set({ theme: 'dark' }))
  await navTo(page, /积微助手/)
  await bar('chat').getByTestId('sidebar-spine').hover()
  await expect(bar('chat')).toHaveAttribute('data-peeking', 'true')
  await page.waitForTimeout(300)
  await shot('sb-peek-dark')
  await page.evaluate(() => window.jiwei.settings.set({ theme: 'system' }))
})
