import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 真实 AI 对话（需要用户先在应用「设置 → AI 模型」中填好服务商与 API Key）。
// 运行：JIWEI_IMPORT_PROVIDERS_FROM=<应用数据库路径> npx playwright test e2e/chat-live.spec.ts
// API Key 以加密形态复制到临时测试目录，不解密、不输出。
const source = process.env.JIWEI_IMPORT_PROVIDERS_FROM
test.skip(!source, '需要 JIWEI_IMPORT_PROVIDERS_FROM（真实服务商配置）')
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
const shots = process.env.SHOTS_DIR

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-live-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

const ask = async (text: string): Promise<void> => {
  await page.getByRole('textbox', { name: '问问你的知识库……' }).fill(text)
  await page.keyboard.press('Enter')
}
const lastAnswer = () => page.locator('.group\\/msg').last()

test('provider imported and knowledge base ready', async () => {
  test.setTimeout(180_000)
  const providers = await page.evaluate(() => window.jiwei.providers.list())
  expect(providers.length).toBeGreaterThan(0)
  expect(providers.some((p) => p.hasKey)).toBe(true)
  const test = await page.evaluate((id) => window.jiwei.providers.test(id), providers.find((p) => p.hasKey)!.id)
  expect(test.ok, test.message ?? '').toBe(true)
  await page.evaluate(() => window.jiwei.embedding.installLocal())
  await page.evaluate(() => window.jiwei.notes.createSample('zh-CN'))
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-live-src-'))
  writeFileSync(
    join(dir, '遗忘曲线.md'),
    '# 艾宾浩斯遗忘曲线\n\n学习后 20 分钟遗忘约 42%，一天后遗忘约 66%。\n\n## 间隔重复\n\n在快要遗忘的时候复习，记忆保持最久。'
  )
  await page.evaluate((p) => window.jiwei.sources.importPaths([p]), join(dir, '遗忘曲线.md'))
  await expect
    .poll(
      async () => {
        const s = await page.evaluate(() => window.jiwei.embedding.status())
        return s.total > 0 && s.indexed === s.total
      },
      { timeout: 90_000 }
    )
    .toBe(true)
})

test('answer with knowledge-base citations (thinking off)', async () => {
  test.setTimeout(120_000)
  await page.getByRole('button', { name: /AI 对话/ }).click()
  await page.getByRole('radio', { name: '关闭' }).click()
  await ask('学习后一天大概会遗忘多少？应该怎么复习？请用我的笔记和资料回答。')
  await expect(lastAnswer().locator('.cite-chip').first()).toBeVisible({ timeout: 90_000 })
  await expect(lastAnswer().getByText(/来自你的知识库/)).toBeVisible({ timeout: 90_000 })
  await expect(lastAnswer().getByText(/tokens/)).toBeVisible({ timeout: 30_000 })
  if (shots) await page.screenshot({ path: join(shots, '61-chat-answer.png') })
})

test('citation jumps to the source passage', async () => {
  await lastAnswer().locator('.cite-chip').first().click()
  await expect(page.locator('.source-text .is-flash, .cornell-doc .is-flash').first()).toBeVisible({ timeout: 10_000 })
  if (shots) await page.screenshot({ path: join(shots, '62-citation-jump.png') })
  await page.getByRole('button', { name: /AI 对话/ }).click()
})

test('thinking effort high returns a reasoning trace', async () => {
  test.setTimeout(240_000)
  await page.getByRole('radio', { name: '高' }).click()
  await ask('比较“间隔重复”和“费曼学习法”各自适合解决什么问题，简要回答。')
  await expect(lastAnswer().getByRole('button', { name: /思考/ })).toBeVisible({ timeout: 180_000 })
  await expect(lastAnswer().getByText(/思考：高/)).toBeVisible({ timeout: 180_000 })
  if (shots) await page.screenshot({ path: join(shots, '63-chat-thinking.png') })
})

test('stop generation', async () => {
  test.setTimeout(120_000)
  await page.getByRole('radio', { name: '关闭' }).click()
  await ask('请写一篇 2000 字的文章，介绍学习科学的发展历史。')
  await page.getByRole('button', { name: '停止生成' }).click({ timeout: 30_000 })
  await expect(lastAnswer().getByText('已停止生成')).toBeVisible({ timeout: 30_000 })
})

test('no knowledge base: answer marked as general knowledge', async () => {
  test.setTimeout(120_000)
  await page.getByRole('button', { name: '新建' }).click()
  await page.getByRole('button', { name: '检索范围' }).click()
  await page.getByRole('menuitem', { name: '不使用知识库' }).click()
  await ask('用一句话解释什么是光合作用。')
  await expect(lastAnswer().getByText(/内容来自模型的通用知识/)).toBeVisible({ timeout: 90_000 })
})
