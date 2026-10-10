import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'

// AI 设置与对话界面（不需要 API Key）：添加服务商、思考强度档位、对话空状态
// 导入真实服务商时（chat-live）跳过：本用例假设没有任何服务商
test.skip(!!process.env.JIWEI_IMPORT_PROVIDERS_FROM, '已导入真实服务商')
test('AI settings and chat UI without a key', async () => {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-ai-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  const page = await app.firstWindow()
  await page.waitForSelector('nav')
  const shots = process.env.SHOTS_DIR

  // 对话页：未配置模型时引导去设置
  await navTo(page, /AI 对话/)
  await expect(page.getByRole('heading', { name: '问积微，或交代一件事' })).toBeVisible()
  await page.getByRole('button', { name: '去设置模型服务' }).click()

  // 设置 → AI：添加 DeepSeek
  await expect(page.getByText('模型服务', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '添加服务' }).click()
  await page.getByRole('menuitem', { name: 'DeepSeek' }).click()
  await expect(page.getByText('未设置 API Key')).toBeVisible()
  await expect(page.getByRole('textbox', { name: '接口地址（Base URL）' })).toHaveValue('https://api.deepseek.com')
  await expect(page.getByLabel('API Key')).toBeVisible()
  // DeepSeek 支持的思考档位：关闭 / 低 / 高 / 极限（没有“中”）
  const radios = page.getByRole('radiogroup', { name: '思考强度' }).getByRole('radio')
  await expect(radios).toHaveText(['关闭', '低', '高', '极限'])
  await expect(page.getByRole('radio', { name: '高', exact: true })).toHaveAttribute('aria-checked', 'true')
  // 模型能力：默认按名称判断（deepseek-flash 能看图、普通；deepseek-v4-pro 纯文本、强模型），可逐个改写
  await expect(page.getByRole('button', { name: 'deepseek-flash 看图' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'deepseek-flash 强模型' })).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByRole('button', { name: 'deepseek-v4-pro 看图' })).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByRole('button', { name: 'deepseek-v4-pro 强模型' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'deepseek-flash 强模型' }).click()
  await expect(page.getByRole('button', { name: 'deepseek-flash 强模型' })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.providers.list()))[0].modelCaps).toEqual({ 'deepseek-flash': { tier: 'strong' } })
  // 再点一次：回到自动判断，不留下设定
  await page.getByRole('button', { name: 'deepseek-flash 强模型' }).click()
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.providers.list()))[0].modelCaps).toEqual({})
  if (shots) await page.screenshot({ path: join(shots, '51-ai-settings.png') })
  // API Key 不会以明文出现在任何接口返回中
  const providers = await page.evaluate(() => window.jiwei.providers.list())
  expect(Object.keys(providers[0])).not.toContain('apiKey')
  await app.close()
})
