import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// monid 连接器（v0.10）：默认不装；安装前写清数据会发给第三方、按调用计费；装好后连接器默认停用，不填 key（官方 OAuth）。
// 不连接真实 monid。
test('monid connector: honest confirmation, disabled by default, no key form', async () => {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-monid-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  const page = await app.firstWindow()
  await page.waitForSelector('nav')
  expect(await page.evaluate(() => window.jiwei.mcp.servers())).toHaveLength(0)
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('button', { name: '插件', exact: true }).click()
  await page.getByRole('group', { name: '插件', exact: true }).getByRole('button', { name: '市场', exact: true }).click()
  const card = page.locator('[data-catalog-id="monid@jiwei"]')
  await expect(card).toContainText('monid 工具集')
  await expect(card).toContainText('连接器')
  await card.getByRole('button', { name: '安装', exact: true }).click()
  const confirm = page.getByTestId('plugin-confirm')
  await expect(confirm).toContainText('会把你的提问或工具参数发给第三方')
  await expect(confirm).toContainText('每次调用按该工具的价格扣费')
  await expect(confirm).toContainText('mcp.monid.ai')
  await expect(confirm).not.toContainText('只包含文字内容')
  // 官方 OAuth：没有要填的 key
  await expect(confirm.locator('input[type="password"]')).toHaveCount(0)
  await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeFocused()
  if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, 'monid-confirm.png') })
  await confirm.getByRole('button', { name: '安装', exact: true }).click()
  await expect(confirm).toHaveCount(0)
  const servers = await page.evaluate(() => window.jiwei.mcp.servers())
  expect(servers).toEqual([expect.objectContaining({ name: 'monid', transport: 'http', url: 'https://mcp.monid.ai/v1', enabled: false })])
  await app.close()
})
