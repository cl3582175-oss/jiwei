import { test, expect, _electron as electron, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { navTo } from './fixtures/nav'

let app: ElectronApplication, page: Page
const title = '概率推理方向 · 练习与检查条件'
const shots = resolve(process.env.SHOTS_DIR ?? `.superpowers/sdd/v0.8-plan-tasks-discovery/shots/p8-layout-${Date.now()}`)
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  mkdirSync(shots, { recursive: true })
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-v08-layout-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  const picks = await page.evaluate(async (title) => {
    const start = new Date().setHours(0, 0, 0, 0),
      end = start + 90 * 86400000,
      goal = await window.jiwei.goals.save({ title, kind: 'exam', startAt: start, targetAt: end, weeklyMinutes: 240, color: 'sky' })
    const phase = await window.jiwei.plan.phaseSave({
      goalId: goal.id,
      title: '先检查前提再练习推理',
      startAt: start + 86400000,
      endAt: start + 20 * 86400000,
      position: 0
    })
    await window.jiwei.plan.milestoneSave({ goalId: goal.id, phaseId: phase.id, title: '完成条件概率练习', at: start + 20 * 86400000 })
    await window.jiwei.plan.eventSave({
      goalId: goal.id,
      kind: 'study',
      title: '推理练习'.repeat(20),
      startAt: start + 10 * 3600000,
      endAt: start + 11 * 3600000
    })
    await window.jiwei.tasks.save({
      name: '每周检查需要复习的概念和待办事项',
      instruction: '阅读到期问题并建议下一步，不编造进度。',
      trigger: { type: 'manual' },
      tools: [],
      outputs: { inbox: true, briefing: true },
      enabled: false
    })
    return Promise.all(
      Array.from({ length: 3 }, async (_, i) => {
        const id = `layout-pick-${i}`,
          inbox = await window.jiwei.inbox.create({ kind: 'pick', text: '精选布局自创样例', origin: { itemId: id } })
        return { id, inboxId: inbox.id }
      })
    )
  }, title)
  await app.evaluate(({ app }, picks) => {
    const path = process.getBuiltinModule('path'),
      require = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json')),
      Database = require('better-sqlite3') as typeof import('better-sqlite3'),
      db = new Database(path.join(app.getPath('userData'), 'data', 'jiwei.db'))
    try {
      for (const p of picks)
        db.prepare(
          "INSERT INTO feed_items(id,url,title,summary,origin,status,reason,minutes,picked_at,fetched_at,inbox_id,created_at,updated_at,updated_by) VALUES (?,?,?,'','feed','picked',?,20,?,?,?,?,?,'test')"
        ).run(
          p.id,
          `https://example.org/${p.id}`,
          '条件概率讲解'.repeat(20),
          '为什么推荐：补足概率推理方向的前提检查。' + 'UnbrokenRecommendationText'.repeat(8),
          Date.now(),
          Date.now(),
          p.inboxId,
          Date.now(),
          Date.now()
        )
    } finally {
      db.close()
    }
  }, picks)
})
test.afterAll(async () => {
  await app?.close()
})

async function contained(root: Locator): Promise<void> {
  await expect(root).toBeVisible()
  const bounds = await root.evaluate((el) => {
    const box = el.getBoundingClientRect()
    return {
      left: box.left,
      right: box.right,
      width: window.innerWidth,
      scroll: el.scrollWidth,
      client: el.clientWidth,
      body: document.documentElement.scrollWidth
    }
  })
  expect(bounds.left).toBeGreaterThanOrEqual(0)
  expect(bounds.right).toBeLessThanOrEqual(bounds.width + 1)
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1)
  expect(bounds.body).toBeLessThanOrEqual(bounds.width + 1)
}

for (const theme of ['light', 'dark'] as const) {
  for (const scene of ['calendar', 'timeline', 'tasks', 'picks'] as const) {
    test(`P8 1000×680 ${theme} ${scene} 不溢出`, async () => {
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: /^设置/ }).click()
      const appearance = page.getByRole('dialog')
      await appearance.getByRole('tab', { name: '外观', exact: true }).click()
      await appearance.getByRole('radio', { name: theme === 'dark' ? '深色' : '浅色', exact: true }).click()
      await page.keyboard.press('Escape')
      await expect(appearance).not.toBeVisible()
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      if (scene === 'calendar') {
        await navTo(page, /^日历/)
        await page.getByRole('radio', { name: '周视图', exact: true }).click()
        await contained(page.getByTestId('calendar-view'))
        await contained(page.getByTestId('calendar-week'))
        await page.screenshot({ path: join(shots, `${theme}-calendar-week.png`) })
        await page.getByRole('radio', { name: '月视图', exact: true }).click()
        await contained(page.getByTestId('calendar-view'))
        await contained(page.getByTestId('calendar-month'))
      } else if (scene === 'timeline') {
        await navTo(page, /^方向/)
        const back = page.getByRole('button', { name: '全部方向', exact: true })
        if (await back.isVisible()) await back.click()
        await page.locator(`[data-goal="${title}"]`).click()
        const timeline = page.getByTestId('timeline')
        await timeline.scrollIntoViewIfNeeded()
        await contained(page.getByTestId('goals-view'))
        await contained(timeline)
        const scrolling = timeline.locator('div.overflow-x-auto').first()
        const dimensions = await scrolling.evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }))
        expect(dimensions.scroll).toBeGreaterThan(dimensions.width)
        await scrolling.evaluate((el) => {
          el.scrollLeft = el.scrollWidth
        })
        expect(await scrolling.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
        await scrolling.evaluate((el) => {
          el.scrollLeft = 0
        })
        await expect(timeline.getByTestId('timeline-phase')).toBeVisible()
      } else if (scene === 'tasks') {
        await page.getByRole('button', { name: /^设置/ }).click()
        await page.getByRole('tab', { name: 'AI 任务', exact: true }).click()
        await contained(page.getByRole('dialog'))
        await contained(page.getByTestId('tasks-settings'))
        await page.getByRole('button', { name: '新建任务', exact: true }).click()
        const editor = page.getByTestId('task-editor')
        await expect(editor).toBeVisible()
        await contained(editor)
        const overflow = await editor.locator('input,textarea,select').evaluateAll(
          (controls) =>
            controls.filter((el) => {
              const r = el.getBoundingClientRect()
              return r.left < 0 || r.right > window.innerWidth + 1
            }).length
        )
        expect(overflow).toBe(0)
      } else {
        await navTo(page, /^收件箱/)
        await page.getByRole('tab', { name: '精选', exact: true }).click()
        await expect(page.getByTestId('picks-view').locator('article')).toHaveCount(3)
        await contained(page.getByTestId('picks-view'))
        const overflow = await page
          .getByTestId('picks-view')
          .locator('article')
          .evaluateAll((cards) => cards.filter((el) => el.scrollWidth > el.clientWidth + 1).length)
        expect(overflow).toBe(0)
      }
      await page.screenshot({ path: join(shots, `${theme}-${scene}.png`) })
    })
  }
}
