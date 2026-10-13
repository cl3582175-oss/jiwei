import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { makePdf } from './fixtures/makePdf'
import { navTo } from './fixtures/nav'
let app: ElectronApplication,
  page: Page,
  sourceId = '',
  noteId = '',
  categoryId = ''
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-source-return-'))
  const files = Array.from({ length: 24 }, (_, i) => {
    const file = join(dir, `资料${String(i).padStart(2, '0')}.pdf`)
    writeFileSync(file, makePdf([[`Source return fixture ${i}`]]))
    return file
  })
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-source-return-data-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  const extra = join(dir, '资料无分类.pdf')
  writeFileSync(extra, makePdf([['Uncategorized source']]))
  const info = await page.evaluate(async (files) => {
    const cat = await window.jiwei.categories.create('source', '返回分类')
    const result = await window.jiwei.sources.importPaths(files, cat.id)
    return { sourceId: result.imported[0].id, categoryId: cat.id }
  }, files)
  await page.evaluate((file) => window.jiwei.sources.importPaths([file], null), extra)
  ;({ sourceId, categoryId } = info)
})
test.afterAll(async () => {
  await app?.close()
})

test('PDF source closes back to the same library filter/category/search/scroll and selected card', async () => {
  await navTo(page, /^资料库/)
  await page.getByRole('button', { name: 'PDF', exact: true }).click()
  await page.getByRole('button', { name: /返回分类/ }).click()
  await page.getByPlaceholder('搜索资料').fill('资料')
  await expect(page.locator('[data-source-id]')).toHaveCount(24)
  sourceId = (await page.locator('[data-source-id]').last().getAttribute('data-source-id'))!
  const scroller = page.getByTestId('library-scroll')
  const card = page.locator(`[data-source-id="${sourceId}"]`)
  await card.scrollIntoViewIfNeeded()
  const before = await scroller.evaluate((el) => el.scrollTop)
  expect(before).toBeGreaterThan(0)
  await card.dblclick()
  await expect(page.getByRole('button', { name: '关闭资料', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭资料', exact: true }).click()
  await expect(page.getByTestId('library-scroll')).toBeVisible()
  await expect(page.getByRole('button', { name: 'PDF', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByPlaceholder('搜索资料')).toHaveValue('资料')
  await expect(card).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(before)
  // 分类过滤仍有一致数量，且分类仍指向原来的 ID。
  await expect(page.locator('[data-source-id]')).toHaveCount(24)
  expect((await page.evaluate((id) => window.jiwei.sources.get(id), sourceId)).categoryId).toBe(categoryId)
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((theme) => window.jiwei.settings.set({ theme }), theme)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await page.screenshot({ path: `.superpowers/sdd/v0.11.1-fixes/shots/p4-library-return-${theme}.png` })
  }
})

test('a note created beside a library source is saved; close returns to library; history reopens the source', async () => {
  await page.locator(`[data-source-id="${sourceId}"]`).dblclick()
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('返回时自动保存')
  await page.keyboard.press('Enter')
  await page.keyboard.type('关闭资料不丢失笔记')
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '返回时自动保存' }).then((ns) => ns.length))).toBe(1)
  noteId = await page.evaluate(() => window.jiwei.notes.list({ search: '返回时自动保存' }).then((ns) => ns[0].id))
  await page.getByRole('button', { name: '关闭资料', exact: true }).click()
  await expect(page.getByTestId('library-scroll')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+[')
  await expect(page.getByRole('button', { name: '关闭资料', exact: true })).toBeVisible()
  await expect(page.locator('.cornell-body')).toContainText('关闭资料不丢失笔记')
  await page.keyboard.press('ControlOrMeta+]')
  await expect(page.getByTestId('library-scroll')).toBeVisible()
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.notes.blocks(id).then((bs) => bs.map((b) => b.text).join('\n')), noteId))
    .toContain('关闭资料不丢失笔记')
})

test('source opened through a note link closes while keeping the original note', async () => {
  await navTo(page, /^笔记/)
  await page.locator(`[data-note-id="${noteId}"]`).first().click()
  await page.evaluate(
    async ({ noteId, sourceId }) => {
      await window.jiwei.proposals.create({
        noteId,
        title: '资料引用',
        auto: true,
        ops: [
          {
            op: 'insert_row',
            afterRowId: null,
            cue: [],
            body: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: '打开引用资料', marks: [{ type: 'link', attrs: { href: `jiwei://source/${sourceId}` } }] }]
              }
            ]
          }
        ]
      })
    },
    { noteId, sourceId }
  )
  await page.locator('.cornell-body a').click()
  await expect(page.getByRole('button', { name: '关闭资料', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭资料', exact: true }).click()
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('返回时自动保存')
  await expect(page.locator('.cornell-body').first()).toContainText('关闭资料不丢失笔记')
  await expect(page.getByTestId('library-scroll')).toHaveCount(0)
})
