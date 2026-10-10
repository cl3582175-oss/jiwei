import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// v0.6.7 真实服务商验收：晨报、今日页侧栏提问、助手全屏页调用 today_overview。
// 运行：JIWEI_IMPORT_PROVIDERS_FROM=<应用数据库路径> npx playwright test e2e/today-live.spec.ts
// 断言只检查可核对的事实（引用了真实条目、没有 Markdown、长度合适），全文另存供人工阅读。
const source = process.env.JIWEI_IMPORT_PROVIDERS_FROM
test.skip(!source, '需要 JIWEI_IMPORT_PROVIDERS_FROM（真实服务商配置）')
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

let app: ElectronApplication, page: Page
const out = process.env.SHOTS_DIR
const record: Record<string, unknown> = {}
const save = (): void => {
  if (!out) return
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'today-live.json'), JSON.stringify(record, null, 2))
}
const OVERDUE = '把第三章的错题重做一遍'
const GOAL = '六月通过考研数学一'

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-today-live-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.evaluate(
    async ({ OVERDUE, GOAL }) => {
      const j = window.jiwei
      for (const title of ['极限与连续', '导数的几何意义', '注意力机制']) {
        const n = await j.notes.create({ categoryId: null })
        await j.notes.update(n.id, { title })
      }
      await j.goals.save({ title: GOAL, targetAt: Date.now() + 40 * 86400000 })
      await j.actions.create(OVERDUE, Date.now() - 2 * 86400000, null)
      await j.actions.create('给导师回复开题报告的修改意见', new Date().setHours(20, 0, 0, 0), null)
      await j.inbox.create({ kind: 'text', text: '泰勒公式的余项怎么理解', origin: {} })
      await j.activity.track([{ kind: 'read', refType: null, refId: null, durationMs: 12 * 60000 }])
    },
    { OVERDUE, GOAL }
  )
})
test.afterAll(async () => {
  save()
  await app?.close()
})

test('真实晨报：引用真实条目、两三句话、不用 Markdown', async () => {
  const brief = await page.evaluate(() => window.jiwei.today.briefing(true))
  record.briefing = brief
  save()
  expect(brief.ai).toBe(true)
  expect(brief.text.length).toBeGreaterThan(15)
  expect(brief.text.length).toBeLessThan(220)
  expect(brief.text).not.toMatch(/[#*`]|^\s*-\s/m)
  expect(brief.text).toMatch(/第三章|错题|开题报告|导师|考研|数学/)
  await page.reload()
  await page.waitForSelector('nav')
  await expect(page.getByTestId('today-briefing-text')).toHaveText(brief.text)
  if (out) await page.screenshot({ path: join(out, 'today-live.png') })
})

test('今日页侧栏：问“今天先做什么”，回答依据页面上的逾期行动项', async () => {
  await page.keyboard.press('ControlOrMeta+j')
  const panel = page.getByRole('complementary', { name: /积微助手/ })
  await expect(panel).toContainText('当前页面：今日')
  await panel.getByRole('button', { name: '今天我应该先做什么？' }).click()
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.chat.conversations()))[0]?.id ?? null).not.toBeNull()
  const id = (await page.evaluate(() => window.jiwei.chat.conversations()))[0].id
  await expect
    .poll(async () => (await page.evaluate((id) => window.jiwei.chat.messages(id), id)).at(-1)?.status, { timeout: 180_000 })
    .toBe('done')
  const answer = (await page.evaluate((id) => window.jiwei.chat.messages(id), id)).at(-1)!.content
  record.panelAnswer = answer
  save()
  expect(answer).toMatch(/第三章|错题|开题报告|导师/)
  if (out) await page.screenshot({ path: join(out, 'today-live-panel.png') })
  await page.keyboard.press('ControlOrMeta+j')
})

test('助手全屏页：问目标还剩多少天，调用 today_overview 回答', async () => {
  await page.getByTestId('nav-rail').getByRole('button', { name: /^积微助手/ }).click()
  await page.getByRole('textbox', { name: '问积微，或交代一件事……' }).fill('我的考研数学目标还剩多少天？今天学了多久？')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.chat.conversations())).length).toBeGreaterThan(1)
  const id = (await page.evaluate(() => window.jiwei.chat.conversations()))[0].id
  await expect
    .poll(async () => (await page.evaluate((id) => window.jiwei.chat.messages(id), id)).at(-1)?.status, { timeout: 180_000 })
    .toBe('done')
  const last = (await page.evaluate((id) => window.jiwei.chat.messages(id), id)).at(-1)!
  record.fullAnswer = { content: last.content, steps: last.steps.map((s) => `${s.tool}: ${s.label}`) }
  save()
  expect(last.content).toMatch(/4[01]\s*天/)
  expect(last.content).toMatch(/12\s*分钟/)
  if (out) await page.screenshot({ path: join(out, 'today-live-chat.png') })
})
