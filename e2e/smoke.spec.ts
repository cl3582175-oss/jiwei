import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 冒烟测试：使用临时数据目录启动构建产物，走一遍核心流程
let app: ElectronApplication
let page: Page
const shots = process.env.SHOTS_DIR

test.beforeAll(async () => {
  const userData = mkdtempSync(join(tmpdir(), 'jiwei-e2e-'))
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, JIWEI_LANG: 'zh-CN' } })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})

test.afterAll(async () => {
  await app?.close()
})

const shot = async (name: string): Promise<void> => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}

test('home renders', async () => {
  await expect(page.getByText('学习热力图')).toBeVisible()
  await shot('01-home')
})

test('create and edit a Cornell note', async () => {
  await page.keyboard.press('ControlOrMeta+n')
  const title = page.getByPlaceholder('笔记标题')
  await expect(title).toBeVisible()
  await title.fill('费曼学习法')
  await page.keyboard.press('Enter')
  await page.keyboard.type('用简单的语言向别人解释一个概念，如果讲不清楚，说明自己还没真正理解。')
  const editors = page.locator('.ProseMirror')
  await editors.nth(0).click()
  await page.keyboard.type('什么是费曼学习法？')
  await editors.nth(2).click()
  await page.keyboard.type('以教促学：输出倒逼输入。')
  await page.waitForTimeout(1200)
  await expect(page.getByText(/\d+ 字/).first()).toBeVisible()
  await shot('02-editor')
})

test('search finds the note (FTS + short query)', async () => {
  const search = page.getByPlaceholder('搜索笔记')
  await search.fill('费曼学')
  await expect(page.locator('aside').getByText('费曼学习法', { exact: true })).toBeVisible()
  await search.fill('倒逼')
  await expect(page.locator('aside').getByText('费曼学习法', { exact: true })).toBeVisible()
  await search.fill('不存在的内容xyz')
  await expect(page.getByText('没有匹配的笔记')).toBeVisible()
  await search.fill('')
})

test('delete → trash → restore', async () => {
  await page.locator('aside').getByText('费曼学习法', { exact: true }).click()
  await page.getByRole('button', { name: '更多' }).click()
  await page.getByRole('menuitem', { name: '删除' }).click()
  await expect(page.getByText('删除这篇笔记？')).toBeVisible()
  await shot('03-confirm')
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('button', { name: '最近删除' }).click()
  await expect(page.getByText('30 天后永久删除')).toBeVisible()
  await shot('04-trash')
  await page.getByRole('button', { name: '还原' }).click()
  await expect(page.getByText('没有最近删除的内容')).toBeVisible()
})

test('library and settings', async () => {
  await page.getByRole('button', { name: /资料库/ }).click()
  await expect(page.getByText('资料库是空的')).toBeVisible()
  await shot('05-library')
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('button', { name: '外观' }).click()
  await page.getByRole('button', { name: '深色' }).click()
  await shot('06-settings-dark')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /笔记/ }).first().click()
  await page.getByRole('button', { name: /笔记/ }).first().click()
  await shot('07-home-dark')
})
