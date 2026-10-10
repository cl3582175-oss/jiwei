import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'

// 学习目标与掌握度地图（不需要 API Key）。
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
const shots = process.env.SHOTS_DIR
const ids: Record<string, string> = {}

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-progress-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const row = (cue: string, body: string) => ({ op: 'insert_row' as const, afterRowId: null, cue: cue ? [p(cue)] : [], body: [p(body)] })

async function note(title: string, rows: ReturnType<typeof row>[], categoryId: string | null): Promise<string> {
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill(title)
  await page.keyboard.press('Enter')
  await page.keyboard.type('开头')
  await expect.poll(() => page.evaluate((t) => window.jiwei.notes.list({ search: t }).then((n) => n.length), title)).toBeGreaterThan(0)
  const id = await page.evaluate((t) => window.jiwei.notes.list({ search: t }).then((n) => n[0].id), title)
  if (categoryId) await page.evaluate(({ id, categoryId }) => window.jiwei.notes.update(id, { categoryId }), { id, categoryId })
  await page.evaluate(({ id, ops }) => window.jiwei.proposals.create({ noteId: id, title: '整理', ops }), { id, ops: rows })
  await page.getByRole('button', { name: '全部接受' }).click()
  await expect(page.getByRole('button', { name: '全部接受' })).toHaveCount(0)
  return id
}

test('setup: notes in a category, cards in different states', async () => {
  const cat = await page.evaluate(() => window.jiwei.categories.create('note', '统计学'))
  ids.cat = cat.id
  ids.pvalue = await note('p 值', [row('p 值是什么？', '原假设成立时，出现当前或更极端结果的概率。'), row('p 值小说明什么？', '数据与原假设不太相符。')], cat.id)
  ids.sd = await note('标准差', [row('标准差衡量什么？', '数据的离散程度。')], cat.id)
  ids.blank = await note('置信区间', [row('', '置信区间给出参数可能的范围。')], cat.id)
  ids.other = await note('边际效用', [row('什么是边际效用递减？', '每多一单位带来的额外满足感减少。')], null)
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.review.stats())).total, { timeout: 15_000 }).toBe(4)
  // 复习“p 值”的两张卡片（记得）
  for (let i = 0; i < 2; i++) {
    const c = await page.evaluate(() => window.jiwei.review.next([]))
    await page.evaluate((id) => window.jiwei.review.rate(id, 3), c!.id)
  }
  const map = await page.evaluate(() => window.jiwei.mastery.map(null))
  const by = Object.fromEntries(map.notes.map((n) => [n.title, n]))
  expect(by['置信区间'].status).toBe('blank')
  expect(by['标准差'].status).toBe('new')
  expect(by['p 值'].reviewed).toBe(2)
  expect(by['p 值'].recall).toBeGreaterThan(0.9)
  expect(by['p 值'].status).toBe('learning')
})

test('mastery map: treemap, filters and list', async () => {
  await page.keyboard.press('ControlOrMeta+4')
  await page.getByRole('tab', { name: '掌握度' }).click()
  await expect(page.getByTestId('mastery-map').locator('svg')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('mastery-map')).toContainText('统计学')
  await page.getByRole('button', { name: /^空白/ }).click()
  await expect(page.locator('[data-note]')).toHaveCount(1)
  await expect(page.locator('[data-note="置信区间"]')).toContainText('还没有线索问题')
  await page.getByRole('button', { name: /^全部/ }).click()
  await expect(page.locator('[data-note]')).toHaveCount(4)
  if (shots) await page.screenshot({ path: join(shots, '151-mastery-map.png') })
})

test('goals: create with a category, progress, actions, link another note', async () => {
  await page.getByRole('tab', { name: '学习目标' }).click()
  await page.getByRole('button', { name: '新建目标' }).click()
  await page.getByRole('dialog').getByRole('textbox', { name: '目标', exact: true }).fill('三个月内能独立做 A/B 测试分析')
  await page.getByRole('dialog').getByRole('combobox', { name: '关联分类' }).selectOption({ label: '统计学' })
  await page.getByRole('dialog').getByRole('button', { name: '保存' }).click()
  const card = page.locator('[data-goal="三个月内能独立做 A/B 测试分析"]')
  await expect(card).toContainText('3 篇笔记')
  await expect(card).toContainText('3 张卡片')
  await card.click()
  await expect(page.getByTestId('goal-stats')).toContainText('2 / 3')
  await expect(page.getByTestId('mastery-map')).toBeVisible()
  // 只显示这个目标范围内的笔记
  await expect(page.locator('[data-note]')).toHaveCount(3)
  await page.getByRole('button', { name: '添加行动项' }).click()
  await page.getByRole('alertdialog').getByRole('textbox').fill('用转化数据做一次检验')
  await page.getByRole('alertdialog').getByRole('button', { name: '保存' }).click()
  await expect(page.locator('[data-action="用转化数据做一次检验"]')).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, '152-goal.png') })

  // 在笔记菜单中把分类外的笔记关联到目标
  await navTo(page, /^笔记/)
  const title = page.getByPlaceholder('笔记标题')
  if (!(await title.count()) || (await title.inputValue()) !== '边际效用') {
    if (await title.count()) await navTo(page, /^笔记/)
    await page.getByText('边际效用', { exact: true }).first().click()
  }
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('边际效用')
  // 笔记编辑器右上角的“更多”（侧栏分类上也有同名按钮）
  await page.getByRole('button', { name: '更多', exact: true }).last().click()
  await page.getByRole('menuitem', { name: '关联到学习目标' }).focus()
  await page.keyboard.press('ArrowRight')
  const item = page.getByRole('menuitem', { name: '三个月内能独立做 A/B 测试分析' })
  await item.focus()
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.goals.list()))[0].noteIds).toContain(ids.other)
  const prog = await page.evaluate((id) => window.jiwei.goals.progress(id), (await page.evaluate(() => window.jiwei.goals.list()))[0].id)
  expect(prog.notes).toBe(4)
  expect(prog.openActions).toBe(1)
})

test('goals appear in the weekly review material', async () => {
  const r = await page.evaluate(() => window.jiwei.reflection.start({ kind: 'weekly' }))
  const m = await page.evaluate((id) => window.jiwei.reflection.material(id), r.id)
  expect(m.goals.map((g) => g.title)).toContain('三个月内能独立做 A/B 测试分析')
  expect(m.text).toContain('学习目标')
})
