import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import type { Server } from 'http'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pageAction, startSite } from './fixtures/browserPage'

// 内置浏览器 + 真实模型（v0.6.0）：网页中“解释”→ 存入笔记（带出处）、AI 面板读当前网页、
// AI 只读浏览工具、离开时把高亮与问答整理成笔记。
// 运行：JIWEI_IMPORT_PROVIDERS_FROM=<应用数据库路径> npx playwright test e2e/browser-live.spec.ts
const source = process.env.JIWEI_IMPORT_PROVIDERS_FROM
test.skip(!source, '需要 JIWEI_IMPORT_PROVIDERS_FROM（真实服务商配置）')
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let server: Server
let base = ''
const shots = process.env.SHOTS_DIR

test.beforeAll(async () => {
  ;({ server, base } = await startSite())
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-browser-live-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
  server?.close()
})

const tabs = () => page.evaluate(() => window.jiwei.browser.state())
const card = () => page.getByRole('dialog', { name: '就地答复' })

test('explain a passage on the page, then save the answer to the note with a source link', async () => {
  test.setTimeout(240_000)
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('记忆方法')
  await page.keyboard.press('Enter')
  await page.keyboard.type(' ')
  await page.getByRole('button', { name: '在笔记旁打开浏览器' }).click()
  await page.getByTestId('browser-start').getByRole('textbox').fill(`${base}/article`)
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await tabs()).tabs[0]?.title).toBe('间隔重复的原理')

  await pageAction(app, '比反复重读更有效', 'explain')
  await expect(card().getByRole('button', { name: '存入笔记' })).toBeEnabled({ timeout: 120_000 })
  await expect(card().locator('.chat-md')).toContainText(/回忆|提取|重读/)
  if (shots) await page.screenshot({ path: join(shots, '203-browser-explain.png') })
  await card().getByRole('button', { name: '存入笔记' }).click()
  await expect(page.locator('.cornell-row').last().getByRole('link', { name: /间隔重复的原理/ })).toBeVisible({ timeout: 10_000 })
})

test('the AI panel reads the current page', async () => {
  test.setTimeout(180_000)
  await page.keyboard.press('ControlOrMeta+j')
  const panel = page.getByRole('complementary', { name: /AI/ })
  await panel.getByRole('textbox').fill('这个网页说复习间隔应该怎么安排？简短回答。')
  await page.keyboard.press('Enter')
  await expect(panel.locator('.group\\/msg').last()).toContainText(/一天|三天|一周|拉长/, { timeout: 120_000 })
  await page.keyboard.press('ControlOrMeta+j')
})

test('the agent can read the open page with browser tools', async () => {
  test.setTimeout(180_000)
  const s = await page.evaluate(() => window.jiwei.settings.get())
  const r = await page.evaluate(
    (inp) => window.jiwei.chat.send(inp as never),
    {
      conversationId: null,
      providerId: s.ai.chat.providerId,
      model: s.ai.chat.model,
      effort: 'off',
      scope: { type: 'all' },
      text: '用浏览器工具读取我在内置浏览器里打开的网页，告诉我它的标题，并引用其中关于“提取练习”的一句话。'
    }
  )
  let content = ''
  let steps: { tool?: string }[] = []
  await expect
    .poll(
      async () => {
        const m = (await page.evaluate((cid) => window.jiwei.chat.messages(cid), r.conversation.id)).find((x) => x.id === r.assistantMessageId)
        content = m?.content ?? ''
        steps = (m?.steps ?? []) as { tool?: string }[]
        return m?.status
      },
      { timeout: 150_000, intervals: [1000] }
    )
    .toBe('done')
  console.log('TOOLS>>', JSON.stringify(steps.map((x) => x.tool)), 'ANSWER>>', content.slice(0, 300))
  expect(content).toContain('间隔重复的原理')
  expect(content).toMatch(/合上书|自己回忆/)
})

test('leaving the page: highlights and Q&A become Cornell rows (proposal)', async () => {
  test.setTimeout(180_000)
  await pageAction(app, '复习间隔应当随着掌握程度逐渐拉长', 'commenting')
  await page.getByTestId('annotation-card').getByRole('textbox').fill('第一次一天，然后三天、一周、一个月')
  await page.keyboard.press('ControlOrMeta+Enter')
  const sourceId = (await tabs()).tabs[0].sourceId!
  const noteId = await page.evaluate(() => window.jiwei.notes.list({ search: '记忆方法' }).then((n) => n[0].id))
  const r = await page.evaluate(({ sourceId, noteId }) => window.jiwei.browser.recap(sourceId, noteId), { sourceId, noteId })
  expect(r.noteId).toBe(noteId)
  const proposals = await page.evaluate((id) => window.jiwei.proposals.list(id), noteId)
  const p = proposals.find((x) => x.id === r.proposalId)!
  console.log('RECAP>>', JSON.stringify(p.ops).slice(0, 600))
  expect(p.ops.length).toBeGreaterThanOrEqual(1)
  expect(JSON.stringify(p.ops)).toContain(`jiwei://source/${sourceId}`)
})
