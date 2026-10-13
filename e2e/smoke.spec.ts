import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'

// 端到端测试：使用临时数据目录启动构建产物，覆盖 v0.1.1 的核心流程（含重启后数据持久化）
const userData = mkdtempSync(join(tmpdir(), 'jiwei-e2e-'))
const shots = process.env.SHOTS_DIR
let app: ElectronApplication
let page: Page

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
}

const shot = async (name: string): Promise<void> => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}
const sidebar = (): ReturnType<Page['locator']> => page.locator('aside').first()

test.describe.configure({ mode: 'serial' })
test.beforeAll(launch)
test.afterAll(async () => {
  await app?.close()
})

test('home renders', async () => {
  // v0.6.7：启动后默认是「今日」；全新用户看到“从一件小事开始”
  await expect(page.getByTestId('today-view')).toBeVisible()
  await expect(page.getByTestId('today-fresh')).toBeVisible()
  await navTo(page, /^笔记/)
  await expect(page.getByText('学习热力图', { exact: true })).toBeVisible()
})

test('Cornell rows: title → notes, cue, new row, summary', async () => {
  await page.keyboard.press('ControlOrMeta+n')
  const title = page.getByPlaceholder('笔记标题')
  await title.fill('费曼学习法')
  await page.keyboard.press('Enter')
  await page.keyboard.type('用简单的语言向别人解释一个概念。')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.type('什么是费曼学习法？')
  await page.getByRole('button', { name: /新增一行知识点/ }).click()
  await page.keyboard.type('讲不清楚，说明自己还没真正理解。')
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.type('如何检验理解？')
  await page.locator('.cornell-summary-content p').click()
  await page.keyboard.type('以教促学：输出倒逼输入。')

  const rows = page.locator('.cornell-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0).locator('.cornell-cue')).toHaveText('什么是费曼学习法？')
  await expect(rows.nth(0).locator('.cornell-body')).toHaveText('用简单的语言向别人解释一个概念。')
  await expect(rows.nth(1).locator('.cornell-cue')).toHaveText('如何检验理解？')
  // 派生完成后：字数更新、行级时间戳出现
  await expect(page.getByText(/\d+ 字 · 编辑于/)).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.cornell-row[data-time]')).toHaveCount(2, { timeout: 5000 })
  await shot('11-cornell-rows')
})

test('meta: learned date, tags, status, history', async () => {
  await expect(page.getByText(/学习于/)).toBeVisible()
  await page.getByRole('button', { name: '添加标签' }).click()
  await page.getByPlaceholder('搜索或新建标签').fill('学习方法')
  await page.getByText('新建标签“学习方法”').click()
  await page.keyboard.press('Escape')
  await expect(sidebar().getByText('学习方法')).toBeVisible()

  await page.locator('main header').getByRole('button', { name: '更多' }).click()
  await page.getByRole('menuitem', { name: /存疑/ }).click()
  await expect(page.getByText('这篇笔记的内容存疑')).toBeVisible()

  await page.locator('main header').getByRole('button', { name: '更多' }).click()
  await page.getByRole('menuitem', { name: '保存当前版本' }).click()
  await page.getByRole('button', { name: '版本历史' }).click()
  await expect(page.getByRole('dialog').getByText('手动保存').first()).toBeVisible()
  await expect(page.getByRole('dialog').locator('.cornell-row')).toHaveCount(2)
  await shot('12-history')
  await page.keyboard.press('Escape')
})

test('content persists when reopening the note', async () => {
  await page.getByRole('button', { name: '返回首页' }).click()
  await sidebar().getByText('费曼学习法', { exact: true }).click()
  await expect(page.locator('.cornell-row').nth(1).locator('.cornell-body')).toHaveText('讲不清楚，说明自己还没真正理解。')
  await expect(page.locator('.cornell-summary-content')).toHaveText('以教促学：输出倒逼输入。')
})

test('full-text search over cue, notes and summary', async () => {
  const search = page.getByPlaceholder('搜索笔记')
  for (const q of ['检验理解', '倒逼', '费曼学习']) {
    await search.fill(q)
    await expect(sidebar().getByText('费曼学习法', { exact: true })).toBeVisible()
  }
  await search.fill('不存在的内容xyz')
  await expect(page.getByText('没有匹配的笔记')).toBeVisible()
  await search.fill('')
})

test('asset protocol serves imported images', async () => {
  const loaded = await page.evaluate(async () => {
    // 1x1 PNG
    const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const ref = await window.jiwei.assets.importBytes('dot.png', 'image/png', bytes)
    return new Promise<boolean>((resolve) => {
      const img = new Image()
      img.onload = () => resolve(img.naturalWidth === 1)
      img.onerror = () => resolve(false)
      img.src = ref.url
    })
  })
  expect(loaded).toBe(true)
})

test('category: nested create, delete with undo, trash', async () => {
  await sidebar().getByRole('button', { name: '新建分类' }).click()
  await page.getByPlaceholder('分类名称').fill('认知科学')
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await expect(sidebar().getByText('认知科学')).toBeVisible()
  const row = sidebar().getByRole('button', { name: /认知科学/ })
  await row.hover()
  await row.getByRole('button', { name: '更多' }).click()
  await page.getByRole('menuitem', { name: '删除' }).click()
  await expect(sidebar().getByText('认知科学')).toHaveCount(0)
  await page.getByRole('button', { name: '撤销' }).click()
  await expect(sidebar().getByText('认知科学')).toBeVisible()
  await sidebar().getByRole('button', { name: '全部笔记' }).click()
})

test('delete note → trash → restore', async () => {
  await sidebar().getByText('费曼学习法', { exact: true }).click()
  await page.locator('main header').getByRole('button', { name: '更多' }).click()
  await page.getByRole('menuitem', { name: '删除' }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('button', { name: '最近删除' }).click()
  await expect(page.getByText('30 天后永久删除')).toBeVisible()
  await page.getByRole('button', { name: '还原' }).click()
  await expect(page.getByText('这里很干净')).toBeVisible()
})

test('settings data tab shows location and backups', async () => {
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('button', { name: '数据' }).click()
  await page.getByTestId('backup-settings').scrollIntoViewIfNeeded()
  await expect(page.getByRole('heading', { name: '备份与恢复' })).toBeVisible()
  await expect(page.getByText('上次本地完整备份', { exact: true })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.jiwei.backups.list().then((list) => list.some((b) => b.format === 'snapshot'))))
    .toBe(true)
  await shot('13-settings-data')
  await page.keyboard.press('Escape')
})

test('everything survives an app restart', async () => {
  await navTo(page, /笔记/)
  await sidebar().getByText('费曼学习法', { exact: true }).click()
  await page.locator('.cornell-summary-content').click()
  await page.keyboard.press('End')
  await page.keyboard.type('（重启前最后一句）')
  // 立即退出：验证退出前的保存握手
  await app.close()
  await launch()
  await navTo(page, /^笔记/)
  await sidebar().getByRole('button', { name: '全部笔记' }).click()
  await sidebar().getByText('费曼学习法', { exact: true }).click()
  await expect(page.locator('.cornell-summary-content')).toHaveText('以教促学：输出倒逼输入。（重启前最后一句）')
  await expect(sidebar().getByText('学习方法')).toBeVisible()
  await expect(sidebar().getByText('认知科学')).toBeVisible()
  await shot('14-after-restart')
})

test('Mod+A clears only the current Cornell grid and keeps the neighbouring row', async () => {
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('局部全选回归')
  await page.keyboard.press('Enter')
  await page.keyboard.type('first grid')
  await page.keyboard.press('ControlOrMeta+Enter')
  await page.keyboard.type('second grid')
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(async (theme) => {
      await window.jiwei.settings.set({ theme })
    }, theme)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await page
      .locator('.cornell-body p')
      .first()
      .click({ position: { x: 5, y: 8 } })
    await expect
      .poll(() =>
        page.evaluate(() => {
          const editor = (document.querySelector('.tiptap') as HTMLElement & { editor: import('@tiptap/core').Editor }).editor
          return { empty: editor.state.selection.empty, text: editor.state.selection.$from.parent.textContent }
        })
      )
      .toEqual({ empty: true, text: 'first grid' })
    await page.keyboard.press('ControlOrMeta+a')
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('first grid')
    await page.screenshot({ path: `.superpowers/sdd/v0.11.1-fixes/shots/p1-select-grid-${theme}.png` })
  }
  await page.keyboard.press('Backspace')
  await expect(page.locator('.cornell-row')).toHaveCount(2)
  await expect(page.locator('.cornell-body').first()).toHaveText('')
  await expect(page.locator('.cornell-body').nth(1)).toHaveText('second grid')
  await expect(page.locator('.cornell-body').first().locator('p')).toHaveCount(1)
  await page.keyboard.type('replacement')
  await expect(page.locator('.cornell-body').first()).toHaveText('replacement')
  await page.getByRole('button', { name: '返回首页' }).click()
  await sidebar().getByText('局部全选回归', { exact: true }).click()
  await expect(page.locator('.cornell-body').first()).toHaveText('replacement')
  await expect(page.locator('.cornell-body').nth(1)).toHaveText('second grid')
})
