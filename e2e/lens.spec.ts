import { test, expect } from '@playwright/test'
import { startLensApp, seedTranscript, openTranscript, lensShot, setLensTheme, type LensApp } from './fixtures/lensApp'
import { navTo } from './fixtures/nav'
test.describe.configure({ mode: 'serial' })
let env: LensApp,
  sourceId = '',
  personIds: string[] = []
test.beforeAll(async () => {
  env = await startLensApp()
  ;({ sourceId, personIds } = await seedTranscript(env, 'meeting'))
  await env.page.reload()
  await env.page.waitForSelector('nav')
})
test.afterAll(async () => env?.close())
test('会议视角 → 编辑负责人日期 → 提案/Yjs落地 → 防重复 → 撤销', async () => {
  const page = env.page
  await openTranscript(env, '预算流程例会')
  await page.getByRole('button', { name: '整理', exact: true }).click()
  const panel = page.getByTestId('lens-panel')
  await panel.getByRole('button', { name: '开始整理', exact: true }).click()
  await expect.poll(() => panel.getByTestId('lens-item').count()).toBe(5)
  await expect(panel.getByTestId('lens-footer')).toContainText('2 张复习卡片')
  await expect(panel.getByText('已丢弃 1 条缺少证据的内容')).toBeVisible()
  const action = panel.getByTestId('lens-item').filter({ hasText: '准备预算表' })
  await action.getByLabel('负责人', { exact: true }).selectOption(personIds[2])
  await action.getByLabel('截止日期', { exact: true }).fill('2026-10-14')
  await action.getByLabel('正文', { exact: true }).fill('请小王准备预算表，保留三个必填字段。')
  await panel.getByRole('button', { name: '落地', exact: true }).click()
  await expect
    .poll(() =>
      env.page.evaluate(() =>
        window.jiwei.actions
          .list()
          .then((a) => a.filter((a) => a.origin).map((a) => ({ title: a.title, owner: a.ownerPersonId, date: a.dueAt })))
      )
    )
    .toEqual([{ title: '请小王准备预算表，保留三个必填字段。', owner: personIds[2], date: new Date('2026-10-14T12:00:00').getTime() }])
  await expect(panel.getByText('已落地 5 条。')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '会议：' }).then((n) => n.length))).toBe(1)
  const landed = await page.evaluate(
    (id) => window.jiwei.lenses.history(id).then(async (ds) => window.jiwei.lenses.landings(ds[0].id)),
    sourceId
  )
  expect(landed[0].blocks.length).toBeGreaterThan(1)
  expect(landed[0].blocks.some((b) => b.snapshot.includes('jiwei://source/'))).toBe(true)
  await expect.poll(() => page.evaluate((id) => window.jiwei.review.forNote(id).then((cards) => cards.length), landed[0].noteId!)).toBe(2)
  await expect(panel.getByRole('button', { name: '落地', exact: true })).toBeDisabled()
  await expect.poll(() => page.evaluate(() => window.jiwei.actions.list().then((a) => a.length))).toBe(1)
  await panel.getByRole('button', { name: '撤销本次落地' }).click()
  await expect.poll(() => page.evaluate(() => window.jiwei.actions.list().then((a) => a.length))).toBe(0)
  await expect(panel.getByText('本次落地已撤销。')).toBeVisible()
})
test('课堂 → 康奈尔行与复习页卡片、概念、作业', async () => {
  const { sourceId } = await seedTranscript(env, 'lecture')
  await env.page.reload()
  await env.page.waitForSelector('nav')
  await openTranscript(env, '学习方法课 · 第二讲')
  await env.page.getByRole('button', { name: '整理', exact: true }).click()
  const panel = env.page.getByTestId('lens-panel')
  await panel.getByRole('button', { name: '开始整理', exact: true }).click()
  await expect.poll(() => panel.getByTestId('lens-item').count()).toBe(7)
  if (process.env.SHOTS_DIR)
    for (const theme of ['light', 'dark'] as const) {
      await setLensTheme(env, theme)
      await panel.getByTestId('lens-item').first().scrollIntoViewIfNeeded()
      await lensShot(env, `lens-lecture-${theme}.png`)
    }
  await panel.getByRole('button', { name: '落地', exact: true }).click()
  await expect
    .poll(() =>
      env.page.evaluate(
        (id) =>
          window.jiwei.lenses.history(id).then(async (ds) => {
            const landing = (await window.jiwei.lenses.landings(ds[0].id))[0]
            return landing?.noteId ? window.jiwei.review.forNote(landing.noteId).then((cards) => cards.length) : 0
          }),
        sourceId
      )
    )
    .toBe(5)
  await expect.poll(() => env.page.evaluate(() => window.jiwei.memory.concepts().then((c) => c.map((c) => c.name)))).toContain('间隔重复')
  await navTo(env.page, /复习/)
  await expect(env.page.getByText(/今日复习/).first()).toBeVisible()
})
test('随想 → 保留原话和 hypothesis 洞见候选', async () => {
  await seedTranscript(env, 'thought')
  await env.page.reload()
  await env.page.waitForSelector('nav')
  await openTranscript(env, '散步时的学习随想')
  await env.page.getByRole('button', { name: '整理', exact: true }).click()
  const panel = env.page.getByTestId('lens-panel')
  await panel.getByRole('button', { name: '开始整理', exact: true }).click()
  await expect.poll(() => panel.getByTestId('lens-item').count()).toBe(4)
  if (process.env.SHOTS_DIR)
    for (const theme of ['light', 'dark'] as const) {
      await setLensTheme(env, theme)
      await panel.getByTestId('lens-item').first().scrollIntoViewIfNeeded()
      await lensShot(env, `lens-thought-${theme}.png`)
    }
  await panel.getByRole('button', { name: '落地', exact: true }).click()
  await expect
    .poll(() =>
      env.page.evaluate(() =>
        window.jiwei.insights.list().then((items) => items.map((i) => ({ statement: i.statement, confidence: i.confidence })))
      )
    )
    .toEqual([{ statement: '我猜，在笔记里留下一个没解决的问题，可能更容易让我回来。', confidence: 'hypothesis' }])
})
