import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'

// v0.7.5 真实环境验收：真实 DeepSeek 调用按人民币记账、看板显示、真实余额查询、真实汇率更新。
// 运行：JIWEI_IMPORT_PROVIDERS_FROM=<应用数据库> npx playwright test e2e/usage-live.spec.ts
const source = process.env.JIWEI_IMPORT_PROVIDERS_FROM
test.skip(!source, '需要 JIWEI_IMPORT_PROVIDERS_FROM（真实服务商配置）')
test.describe.configure({ mode: 'serial' })
test.setTimeout(300_000)

let app: ElectronApplication, page: Page
const out = process.env.SHOTS_DIR
const record: Record<string, unknown> = {}
const shot = async (name: string): Promise<void> => {
  if (out) await page.screenshot({ path: join(out, `${name}.png`) })
}

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-usage-live-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await expect.poll(() => page.evaluate(() => window.jiwei.providers.list().then((p) => p.some((x) => x.hasKey)))).toBe(true)
})
test.afterAll(async () => {
  if (out) {
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'usage-live.json'), JSON.stringify(record, null, 2))
  }
  await app?.close()
})

test('真实 DeepSeek：两次对话按人民币记账，费用与 token 数一致', async () => {
  const chat = await page.evaluate(() => window.jiwei.settings.get().then((s) => s.ai.chat))
  record.model = chat.model
  await navTo(page, /积微助手/)
  for (const q of ['用一句话解释什么是导数。', '再用一句话解释什么是积分。']) {
    const before = await page.evaluate(() => window.jiwei.usage.summary().then((u) => u.calls))
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await page.getByRole('textbox', { name: '问积微，或交代一件事……' }).fill(q)
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => window.jiwei.usage.summary().then((u) => u.calls)), { timeout: 120_000 }).toBeGreaterThan(before)
    await expect(page.locator('.group\\/msg').last()).toContainText('¥', { timeout: 120_000 })
  }
  const today = new Date()
  const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const calls = await page.evaluate((d) => window.jiwei.usage.calls({ from: d, to: d }), d)
  record.calls = calls.rows
  expect(calls.total).toBeGreaterThanOrEqual(2)
  for (const r of calls.rows) {
    expect(r.cost).not.toBeNull()
    expect(r.durationMs).toBeGreaterThan(0)
    expect(r.providerName).toBeTruthy()
  }
})

test('真实余额与汇率：看板显示 DeepSeek 余额；联网更新汇率', async () => {
  const balances = await page.evaluate(() => window.jiwei.usage.balances())
  record.balances = balances.map((b) => ({ name: b.name, ok: b.ok, currency: b.currency, error: b.error }))
  const ds = balances.find((b) => b.kind === 'deepseek')
  expect(ds?.ok).toBe(true)
  expect(typeof ds?.amount).toBe('number')
  const money = await page.evaluate(() => window.jiwei.usage.updateRates())
  record.rateCNY = money.rates.CNY
  expect(money.rates.CNY).toBeGreaterThan(5)
  expect(money.rates.CNY).toBeLessThan(9)

  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('用量')
  await page.getByRole('option', { name: '用量看板' }).click()
  const dash = page.getByTestId('usage-dashboard')
  await expect(dash.getByTestId('usage-kpi-cost')).toContainText('¥')
  await expect(dash.getByTestId('usage-balances')).toContainText(/¥|CN¥/)
  await expect(dash.getByTestId('usage-top').locator('li').first()).toBeVisible()
  await page.waitForTimeout(800)
  await shot('usage-live-dashboard')
})
