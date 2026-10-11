import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page
test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-plan-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
})
test.afterAll(async () => {
  await app?.close()
})

test('P1 方向表单、日历导航、每周投入持久化', async () => {
  await navTo(page, /^方向/)
  await page.getByRole('button', { name: '新建方向' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '方向名称' }).fill('学习概率统计')
  await dialog.getByLabel('方向类型').selectOption('exam')
  await dialog.getByLabel('每周可投入（分钟）').fill('180')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByTestId('goals-view')).toContainText('考试')
  const goals = await page.evaluate(() => window.jiwei.goals.list())
  expect(goals[0]).toMatchObject({ title: '学习概率统计', kind: 'exam', weeklyMinutes: 180 })
  await navTo(page, /^日历/)
  await expect(page.getByTestId('calendar-view')).toBeVisible()
  await page.getByRole('button', { name: '月视图' }).click()
  await expect(page.getByTestId('calendar-month')).toBeVisible()
  await page.getByRole('button', { name: '周视图' }).click()
})

test('P1 拖选创建、拖动改期、完成日程与今日安排', async () => {
  const slot = page.getByTestId('calendar-day').first()
  const box = (await slot.boundingBox())!
  await page.mouse.move(box.x + 35, box.y + 70)
  await page.mouse.down()
  await page.mouse.move(box.x + 35, box.y + 102, { steps: 5 })
  await page.mouse.up()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('日程标题').fill('学习时段')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  const event = page.getByTestId('calendar-event').filter({ hasText: '学习时段' })
  await expect(event).toBeVisible()
  const before = await page.evaluate(() => window.jiwei.plan.events({ startAt: 0, endAt: Date.now() + 365 * 86400000 }))
  const b = (await event.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 32, { steps: 5 })
  await page.mouse.up()
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.plan.events({ startAt: 0, endAt: Date.now() + 365 * 86400000 })))[0].startAt)
    .not.toBe(before[0].startAt)
  await event.click()
  await page.getByRole('dialog').getByRole('button', { name: '标记完成' }).click()
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.plan.events({ startAt: 0, endAt: Date.now() + 365 * 86400000 })))[0].status)
    .toBe('done')
  await page.evaluate(async () => {
    const startAt = new Date().setHours(18, 0, 0, 0)
    await window.jiwei.plan.eventSave({ title: '今日自习', kind: 'study', startAt, endAt: startAt + 3600000 })
  })
  await page.keyboard.press('ControlOrMeta+9')
  expect((await page.evaluate(() => window.jiwei.today.summary())).schedule.some((e) => e.title === '今日自习')).toBe(true)
  await expect(page.getByTestId('today-schedule')).toContainText('今日自习')
  await page.getByTestId('today-schedule').getByRole('button', { name: '标记完成' }).click()
  const s = await page.evaluate(() => window.jiwei.today.summary())
  expect(s.schedule.find((e) => e.title === '今日自习')?.status).toBe('done')
  await navTo(page, /^日历/)
  const forecast = await page.evaluate(() => window.jiwei.plan.forecast(7))
  await expect(page.locator(`[data-forecast-date="${forecast[0].date}"]`)).toHaveAttribute('data-load', String(forecast[0].due + forecast[0].new))
})

test('P1 真实笔记线索生成的卡片进入复习负荷预测', async () => {
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('概率复习')
  await page.keyboard.press('Enter')
  await page.keyboard.type('复习说明')
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.notes.list({ search: '概率复习' }))).length).toBe(1)
  const id = await page.evaluate(async () => (await window.jiwei.notes.list({ search: '概率复习' }))[0].id)
  await page.evaluate(async (id) => {
    const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
    await window.jiwei.settings.set({ review: { newPerDay: 2, retention: 0.9 } })
    await window.jiwei.proposals.create({ noteId: id, title: '复习问题', ops: [1, 2, 3].map((i) => ({ op: 'insert_row', afterRowId: null, cue: [p(`概率问题 ${i}？`)], body: [p(`概率解释 ${i}。`)] })) })
  }, id)
  await page.getByRole('button', { name: '全部接受' }).click()
  await expect.poll(async () => (await page.evaluate((id) => window.jiwei.review.forNote(id), id)).length).toBe(3)
  const forecast = await page.evaluate(() => window.jiwei.review.forecast(3))
  expect(forecast.map((d) => d.new)).toEqual([2, 1, 0])
  await navTo(page, /^日历/)
  await expect(page.locator(`[data-forecast-date="${forecast[0].date}"]`)).toHaveAttribute('data-load', '2')
})
