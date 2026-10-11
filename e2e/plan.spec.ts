import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, type Server } from 'http'
import { navTo } from './fixtures/nav'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page
let server: Server, icsTitle = '外部学习讨论'
const calendarRequests: { at: number; ua: string; conditional?: string }[] = []
test.beforeAll(async () => {
  server = createServer((req, res) => {
    // Node 将请求头按 latin1 解码；Electron 默认 UA 包含中文应用名，先还原线上 UTF-8 字节。
    calendarRequests.push({ at: Date.now(), ua: Buffer.from(String(req.headers['user-agent']), 'latin1').toString('utf8'), conditional: String(req.headers['if-none-match'] ?? '') })
    const d = new Date(); d.setDate(d.getDate() + 1)
    const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    res.setHeader('content-type', 'text/calendar')
    res.setHeader('etag', `"${encodeURIComponent(icsTitle)}"`)
    if (req.headers['if-none-match'] === `"${encodeURIComponent(icsTitle)}"`) { res.writeHead(304); res.end(); return }
    res.end(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:discussion\r\nDTSTART:${date}T100000\r\nDTEND:${date}T110000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:${icsTitle}\r\nEND:VEVENT\r\nEND:VCALENDAR`)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-plan-'))}`],
    env: { ...process.env, JIWEI_TEST_NETWORK: '1', JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
})
test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((r) => server.close(() => r()))
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

test('P2 ICS 重复事件只读、刷新整批替换和隐藏订阅', async () => {
  await navTo(page, /^日历/)
  await page.getByRole('button', { name: '订阅日历' }).click()
  const dialog = page.getByRole('dialog'), url = `http://127.0.0.1:${(server.address() as { port: number }).port}/calendar.ics`
  await dialog.getByLabel('订阅名称').fill('学习讨论日历')
  await dialog.getByLabel('订阅地址').fill(url)
  await dialog.getByRole('button', { name: '添加订阅' }).click()
  const range = { startAt: Date.now() - 86400000, endAt: Date.now() + 10 * 86400000 }
  await expect.poll(async () => (await page.evaluate((r) => window.jiwei.plan.events(r), range)).filter((e) => e.origin === 'ics').length).toBe(3)
  const feed = (await page.evaluate(() => window.jiwei.plan.icsFeeds()))[0]
  const before = (await page.evaluate((r) => window.jiwei.plan.events(r), range)).filter((e) => e.origin === 'ics')
  expect(before.every((e) => e.readonly)).toBe(true)
  await expect(page.evaluate((e) => window.jiwei.plan.eventSave({ ...e, title: '非法编辑' }), before[0])).rejects.toThrow('read-only')
  icsTitle = '讨论时间更新'
  await page.evaluate((id) => window.jiwei.plan.icsRefresh(id), feed.id)
  const after = (await page.evaluate((r) => window.jiwei.plan.events(r), range)).filter((e) => e.origin === 'ics')
  expect(after).toHaveLength(3)
  expect(after.every((e) => e.title === '讨论时间更新')).toBe(true)
  expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id))
  await page.evaluate((id) => window.jiwei.plan.icsRefresh(id), feed.id)
  expect(calendarRequests.at(-1)?.conditional).toBe(`"${encodeURIComponent(icsTitle)}"`)
  expect(calendarRequests[1].at - calendarRequests[0].at).toBeGreaterThanOrEqual(2000)
  const defaultUA = await app.evaluate(({ session }) => session.defaultSession.getUserAgent())
  expect(calendarRequests.map((r) => r.ua)).toEqual(calendarRequests.map(() => defaultUA))
  await page.evaluate((feed) => window.jiwei.plan.icsSave({ ...feed, enabled: false }), feed)
  expect((await page.evaluate((r) => window.jiwei.plan.events(r), range)).some((e) => e.origin === 'ics')).toBe(false)
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
})

test('P2 本地 ICS 一次性导入为只读伪订阅', async () => {
  const d = new Date(), end = new Date(); end.setDate(end.getDate() + 1)
  const date = (v: Date) => `${v.getFullYear()}${String(v.getMonth() + 1).padStart(2, '0')}${String(v.getDate()).padStart(2, '0')}`
  const file = join(mkdtempSync(join(tmpdir(), 'jiwei-ics-file-')), 'calendar.ics')
  writeFileSync(file, `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:local\r\nDTSTART;VALUE=DATE:${date(d)}\r\nDTEND;VALUE=DATE:${date(end)}\r\nSUMMARY:导入的全天日程\r\nEND:VEVENT\r\nEND:VCALENDAR`)
  await app.evaluate(({ dialog }, file) => {
    const state = globalThis as unknown as { savedIcsDialog: typeof dialog.showOpenDialog }
    state.savedIcsDialog = dialog.showOpenDialog
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
  }, file)
  try {
    await page.getByRole('button', { name: '订阅日历' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '导入 .ics 文件' }).click()
    await expect(page.getByRole('dialog')).toContainText('calendar.ics')
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.getByTestId('calendar-view')).toContainText('导入的全天日程')
    const event = (await page.evaluate(() => window.jiwei.plan.events({ startAt: new Date().setHours(0, 0, 0, 0), endAt: new Date().setHours(24, 0, 0, 0) }))).find((e) => e.title === '导入的全天日程')!
    expect(event).toMatchObject({ allDay: true, readonly: true, origin: 'ics' })
    await expect(page.evaluate((id) => window.jiwei.plan.eventRemove(id), event.id)).rejects.toThrow('read-only')
  } finally {
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = (globalThis as unknown as { savedIcsDialog: typeof dialog.showOpenDialog }).savedIcsDialog })
  }
})

test('P2 阶段与里程碑时间线，拖动阶段持久化并可挂接笔记', async () => {
  await navTo(page, /^方向/)
  await page.locator('[data-goal="学习概率统计"]').click()
  await page.getByRole('button', { name: '新建阶段' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('阶段名称').fill('概念入门')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  const goal = (await page.evaluate(() => window.jiwei.goals.list()))[0]
  const before = (await page.evaluate((id) => window.jiwei.plan.phases(id), goal.id))[0]
  const bar = page.getByTestId('timeline-phase').filter({ hasText: '概念入门' })
  const box = (await bar.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 14)
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 30, box.y + 14, { steps: 5 }); await page.mouse.up()
  await expect.poll(async () => (await page.evaluate((id) => window.jiwei.plan.phases(id), goal.id))[0].startAt).not.toBe(before.startAt)
  await page.getByRole('button', { name: '新建里程碑' }).click()
  await page.getByRole('dialog').getByLabel('里程碑名称').fill('完成基础练习')
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByTestId('timeline')).toContainText('完成基础练习')
  await bar.click()
  await page.getByRole('dialog').getByRole('button', { name: '关联笔记', exact: true }).click()
  await page.getByRole('option', { name: /概率复习/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click()
  expect((await page.evaluate((id) => window.jiwei.plan.phases(id), goal.id))[0].noteIds).toHaveLength(1)
})
