import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'

// 侧栏收展：⌘\ 与导航栏按钮切换，资料区与笔记区随之变宽，重启后保持
test('sidebar collapses to give space to the source and note panes', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'jiwei-e2e-sb-'))
  const launch = () =>
    electron.launch({
      args: ['.', `--user-data-dir=${userData}`],
      env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
    })
  let app = await launch()
  let page = await app.firstWindow()
  await page.waitForSelector('nav')
  const sidebar = (p: Page) => p.locator('[data-collapsed]').first()
  const mainWidth = (p: Page) =>
    p
      .locator('.panel')
      .first()
      .evaluate((el) => el.getBoundingClientRect().width)

  // 打开资料 + 笔记：四栏并存
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-src-'))
  writeFileSync(join(dir, '资料.md'), '# 资料\n\n正文。')
  await page.evaluate((p) => window.jiwei.sources.importPaths([p]), join(dir, '资料.md'))
  await page.keyboard.press('ControlOrMeta+n')
  const src = await page.evaluate(() => window.jiwei.sources.list({}).then((s) => s[0].id))
  await page.evaluate((id) => window.jiwei.sources.get(id), src)
  await page.getByRole('button', { name: '在左侧打开资料' }).click()
  await page.getByText('资料', { exact: true }).last().click()
  await expect(page.locator('.source-text')).toBeVisible()

  const before = await mainWidth(page)
  await page.keyboard.press('ControlOrMeta+\\')
  await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'true')
  await page.waitForTimeout(400)
  const after = await mainWidth(page)
  expect(after - before).toBeGreaterThan(280)
  if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, '41-sidebar-collapsed.png') })

  // 导航栏按钮展开
  await page.getByRole('button', { name: /展开侧栏/ }).click()
  await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'false')

  // 收起后重启仍保持
  await page.getByRole('button', { name: /收起侧栏/ }).click()
  await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'true')
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  // v0.6.7 起启动后是「今日」（没有侧栏），到笔记页检查
  await navTo(page, /^笔记/)
  await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'true')
  // 资料库页同样收起
  await navTo(page, /资料库/)
  await expect(sidebar(page)).toHaveAttribute('data-collapsed', 'true')
  await app.close()
})
