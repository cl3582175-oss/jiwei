import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'http'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'

// v0.7.5：币种自由选择、模型价格、用量看板（概览、趋势、用途、服务商、最贵的几次、明细与导出）、接近上限提醒。
// 受控服务商：返回固定 token 用量；汇率服务也由同一个本地服务器提供。

const shots = process.env.SHOTS_DIR
const exportDir = mkdtempSync(join(tmpdir(), 'jiwei-usage-export-'))
let app: ElectronApplication, page: Page, server: Server
let rateHits = 0
const ids: Record<string, string> = {}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/rates')) {
      rateHits++
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ result: 'success', rates: { USD: 1, CNY: 7, EUR: 0.9, XAF: 600 } }))
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const input = JSON.parse(body || '{}') as { model?: string }
      const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(chunk({ role: 'assistant', content: '好的。' }, null))
      res.write(
        chunk({}, 'stop', {
          prompt_tokens: 100_000,
          completion_tokens: 10_000,
          total_tokens: 110_000,
          prompt_tokens_details: { cached_tokens: 40_000 }
        })
      )
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-usage-'))}`],
    env: {
      ...process.env,
      JIWEI_LANG: 'zh-CN',
      JIWEI_SKIP_ONBOARDING: '1',
      JIWEI_IMPORT_PROVIDERS_FROM: '',
      JIWEI_EXPORT_DIR: exportDir,
      JIWEI_RATES_URL: `http://127.0.0.1:${port}/rates`
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  const baseUrl = `http://127.0.0.1:${port}/v1`
  Object.assign(
    ids,
    await page.evaluate(async (baseUrl) => {
      const j = window.jiwei
      const a = await j.providers.save({ kind: 'ollama', name: '甲服务商', baseUrl, models: ['deepseek-flash'] })
      const b = await j.providers.save({ kind: 'ollama', name: '乙服务商', baseUrl, models: ['kimi-k2.6', 'local-x'] })
      return { a: a.id, b: b.id }
    }, baseUrl)
  )
})
test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((r) => server.close(() => r()))
})

const shot = async (name: string): Promise<void> => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}
async function useModel(providerId: string, model: string): Promise<void> {
  await page.evaluate(
    async ({ providerId, model }) => {
      const s = await window.jiwei.settings.get()
      await window.jiwei.settings.set({ ai: { ...s.ai, chat: { providerId, model }, effort: 'off' } })
    },
    { providerId, model }
  )
  // 对话框的模型选择读取设置缓存：重新载入后生效
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /积微助手/)
}
async function ask(text: string): Promise<void> {
  const before = await page.evaluate(() => window.jiwei.usage.summary().then((u) => u.calls))
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  const box = page.getByRole('textbox', { name: '问积微，或交代一件事……' })
  await box.fill(text)
  await page.keyboard.press('Enter')
  await expect
    .poll(() => page.evaluate(() => window.jiwei.usage.summary().then((u) => u.calls)), { timeout: 20_000 })
    .toBeGreaterThan(before)
}

test('三家模型各用一次：按人民币显示，价格未知的单独提示', async () => {
  await navTo(page, /积微助手/)
  await useModel(ids.a, 'deepseek-flash')
  await ask('第一个问题')
  await ask('第二个问题')
  await useModel(ids.b, 'kimi-k2.6')
  await ask('第三个问题')
  await useModel(ids.b, 'local-x')
  await ask('第四个问题')
  // 回答下方的费用按人民币显示
  await expect(page.locator('.group\\/msg').last()).not.toContainText('$')
  const u = await page.evaluate(() => window.jiwei.usage.summary())
  expect(u.unpriced).toBeGreaterThanOrEqual(1)
  // Kimi 标价为人民币：100k 输入（40k 命中缓存）+ 10k 输出 = (60k×6.5 + 40k×1.1 + 10k×27) / 1M = ¥0.704 → 美元
  const kimi = u.byModel.find((b) => b.key === 'kimi-k2.6')!
  expect(kimi.cost).toBeCloseTo(0.704 / 6.7069, 3)
})

test('设置 → 费用与权限：默认人民币；换币种时上限一并换算；没有汇率的币种先填汇率', async () => {
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('tab', { name: '费用与权限' }).click()
  const view = page.getByTestId('usage-settings')
  await expect(view.getByTestId('usage-month')).toContainText('¥')
  await expect(view.getByTestId('usage-forecast')).toContainText('月底约')
  await view.getByRole('textbox', { name: '每天' }).fill('10')
  await view.getByRole('textbox', { name: '每天' }).press('Enter')
  await expect
    .poll(() => page.evaluate(() => window.jiwei.settings.get().then((s) => s.budget)))
    .toMatchObject({ daily: 10, currency: 'CNY' })
  await shot('usage-settings-cny')

  // 换成美元：上限 ¥10 → $1.49
  await view.getByTestId('currency-picker').click()
  await page.getByPlaceholder('搜索币种（名称或代码）').fill('USD')
  await page.getByRole('option', { name: /美元/ }).first().click()
  await expect(view.getByTestId('usage-month')).toContainText('US$')
  const b = await page.evaluate(() => window.jiwei.settings.get().then((s) => s.budget))
  expect(b.currency).toBe('USD')
  expect(b.daily).toBeCloseTo(10 / 6.7069, 2)

  // 中非法郎没有内置汇率：先提示，填写汇率后切换
  await view.getByTestId('currency-picker').click()
  await page.getByPlaceholder('搜索币种（名称或代码）').fill('XAF')
  await page.getByRole('option').first().click()
  await expect(view).toContainText('积微没有 XAF 的汇率')
  await view.getByTestId('currency-rate').fill('600')
  await view.getByTestId('currency-rate').press('Enter')
  await expect.poll(() => page.evaluate(() => window.jiwei.settings.get().then((s) => s.money.currency))).toBe('XAF')
  await expect(view).toContainText('手动设定')

  // 联网更新汇率：来自受控服务器
  await view.getByRole('button', { name: '立即更新' }).click()
  await expect.poll(() => rateHits).toBe(1)
  await expect(view).toContainText('联网更新于')
  const m = await page.evaluate(() => window.jiwei.settings.get().then((s) => s.money))
  expect(m.rates.CNY).toBe(7)
  expect(m.ratesAt).toBeGreaterThan(0)

  // 回到人民币（汇率已更新为 7）
  await view.getByTestId('currency-picker').click()
  await page
    .getByRole('option', { name: /人民币/ })
    .first()
    .click()
  await expect(view.getByTestId('usage-month')).toContainText('¥')
  await page.keyboard.press('Escape')
})

test('AI 模型：价格小标，填写未知模型的价格后补算历史', async () => {
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('tab', { name: 'AI 模型' }).click()
  await page.getByRole('button', { name: /^乙服务商 http/ }).click()
  const row = page.locator('[data-model="local-x"]')
  const kimiRow = page.locator('[data-model="kimi-k2.6"]')
  await expect(kimiRow.getByTestId('price-chip')).toContainText('¥6.50 / ¥27.00')
  await expect(row.getByTestId('price-chip')).toContainText('价格未知')
  await row.getByTestId('price-chip').click()
  const editor = page.getByTestId('price-editor')
  await editor.getByLabel('输入', { exact: true }).fill('1')
  await editor.getByLabel('输出', { exact: true }).fill('4')
  await shot('usage-price-editor')
  await editor.getByRole('button', { name: '保存' }).click()
  await expect(row.getByTestId('price-chip')).toContainText('¥1.00 / ¥4.00')
  // 只改价格不会把服务商名称、接口地址重置为预设值
  await expect(page.getByRole('button', { name: /^乙服务商 http:\/\/127\.0\.0\.1/ })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.jiwei.usage.summary().then((u) => u.unpriced))).toBe(0)
  // 焦点回到价格小标时会显示提示：第一次 Esc 关提示，第二次关设置
  await expect(async () => {
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '设置' })).toHaveCount(0, { timeout: 500 })
  }).toPass()
})

test('用量看板：概览、趋势、用途、服务商、最贵的几次、明细筛选与导出', async () => {
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('用量')
  await page.getByRole('option', { name: '用量看板' }).click()
  const dash = page.getByTestId('usage-dashboard')
  await expect(dash).toBeVisible()
  await expect(dash.getByTestId('usage-kpi-cost')).toContainText('¥')
  await expect(dash.getByTestId('usage-kpi-calls')).toHaveText('4')
  await expect(dash.getByTestId('usage-kpi-cache')).toHaveText('40%')
  await expect(dash.getByTestId('usage-trend').locator('svg')).toBeVisible()
  await expect(dash.getByTestId('usage-providers')).toContainText('甲服务商')
  await expect(dash.getByTestId('usage-providers')).toContainText('乙服务商')
  await expect(dash.getByTestId('usage-providers')).toContainText('local-x')
  await expect(dash.getByTestId('usage-purposes')).toContainText('助手对话')
  await expect(dash.getByTestId('usage-callers')).toContainText('积微助手')
  await expect(dash.getByTestId('usage-top').locator('li')).toHaveCount(4)
  await expect(dash.getByTestId('usage-forecast-card')).toContainText('预计月底')
  await expect(dash.getByTestId('usage-calls').locator('tbody tr')).toHaveCount(4)
  await shot('usage-dashboard')

  // 点服务商筛选明细
  await dash
    .getByTestId('usage-providers')
    .getByRole('button', { name: /甲服务商/ })
    .click()
  await expect(dash.getByTestId('usage-filter')).toContainText('甲服务商')
  await expect(dash.getByTestId('usage-calls').locator('tbody tr')).toHaveCount(2)
  await dash.getByTestId('usage-export').click()
  await expect(page.getByText(/已导出到/)).toBeVisible()
  const csv = readFileSync(
    join(
      exportDir,
      (await import('fs')).readdirSync(exportDir).find((f) => f.endsWith('.csv'))!
    ),
    'utf8'
  )
  expect(csv.split('\n')[0]).toContain('cost_cny')
  expect(csv.split('\n').length).toBe(3)
  expect(csv).toContain('甲服务商')
  await dash.getByRole('button', { name: '清除筛选' }).click()
  await expect(dash.getByTestId('usage-calls').locator('tbody tr')).toHaveCount(4)

  // 最贵的一次可以回到对话
  await dash.getByTestId('usage-top').getByRole('button', { name: '打开对话' }).first().click()
  await expect(page.getByTestId('usage-dashboard')).toHaveCount(0)
})

test('时间范围：今天与自定义；上一时段为空时不显示涨跌', async () => {
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('用量')
  await page.getByRole('option', { name: '用量看板' }).click()
  const dash = page.getByTestId('usage-dashboard')
  await page.getByRole('radio', { name: '今天' }).click()
  await expect(dash.getByTestId('usage-kpi-calls')).toHaveText('4')
  await page.getByRole('radio', { name: '自定义' }).click()
  await page.getByLabel('开始').fill('2020-01-01')
  await page.getByLabel('结束').fill('2020-01-31')
  await expect(dash.getByTestId('usage-kpi-calls')).toHaveText('0')
  await expect(dash).toContainText('这段时间还没有 AI 调用')
})

test('接近每日上限时提醒一次，可直接打开看板', async () => {
  await navTo(page, /积微助手/)
  await useModel(ids.a, 'deepseek-flash')
  // 让下一次调用后达到 80% 到 100% 之间
  const { spent, one } = await page.evaluate(async () => {
    const u = await window.jiwei.usage.summary()
    const today = new Date()
    const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const c = await window.jiwei.usage.calls({ from: d, to: d, model: 'deepseek-flash', limit: 1 })
    return { spent: u.today, one: c.rows[0].cost! }
  })
  await page.evaluate(
    (daily) => window.jiwei.settings.set({ budget: { perRun: null, daily, monthly: null, currency: 'USD' } }),
    (spent + one) / 0.9
  )
  await ask('再问一次')
  const toast = page.getByText(/今天的花费已达上限的 9\d%/)
  await expect(toast).toBeVisible({ timeout: 10_000 })
  await shot('usage-alert')
  await page.getByRole('button', { name: '查看看板' }).click()
  await expect(page.getByTestId('usage-dashboard')).toBeVisible()
  await page.evaluate(() => window.jiwei.settings.set({ budget: { perRun: null, daily: null, monthly: null, currency: 'CNY' } }))
})

test('窄窗与深色：看板不溢出', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  const dash = page.getByTestId('usage-dashboard')
  await expect(dash).toBeVisible()
  const overflow = await dash.evaluate((el) => el.scrollWidth - el.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  await shot('usage-dashboard-dark')
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
})
