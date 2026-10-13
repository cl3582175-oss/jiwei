import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 首次启动引导：认识积微 → 接上 AI 大脑（可跳过）→ 个性化（名字、配色）→ 选角色（可跳过）→ 康奈尔笔记法 → 打开示例笔记；完成后不再出现
test('first run onboarding creates the sample note', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'jiwei-e2e-ob-'))
  const launch = () => electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, JIWEI_LANG: 'zh-CN' } })
  let app = await launch()
  let page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: '欢迎来到积微' })).toBeVisible()
  if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, '31-onboarding-1.png') })
  await page.getByRole('button', { name: '开始' }).click()
  // 模型配置：默认选中 DeepSeek，展示三步教程；Key 格式不对时用人话提示；可以先跳过
  await expect(page.getByRole('heading', { name: '给积微接上 AI 大脑' })).toBeVisible()
  await expect(page.getByText('打开DeepSeek官网，注册并登录')).toBeVisible()
  await expect(page.getByRole('link', { name: /打开DeepSeek获取 Key 的页面/ })).toHaveAttribute('href', /platform\.deepseek\.com/)
  await page.getByTestId('setup-qwen').click()
  await expect(page.getByText('打开通义千问官网，注册并登录')).toBeVisible()
  if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, '31b-onboarding-ai.png') })
  await page.getByTestId('setup-later').click()
  await page.getByPlaceholder('协作时显示的名字').fill('小积')
  await page.getByRole('button', { name: '敦煌' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'dunhuang')
  if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, '32-onboarding-2.png') })
  await page.getByRole('button', { name: '下一步' }).click()
  // 角色：分“学生 / 工作”两组，不选可以跳过
  await expect(page.getByRole('heading', { name: '你主要用积微做什么？' })).toBeVisible()
  await expect(page.getByTestId('role-grid').getByRole('heading', { name: '我是学生' })).toBeVisible()
  await expect(page.locator('[data-role-id="role-kaoyan@jiwei"]')).toBeVisible()
  await page.locator('[data-role-id="role-kaoyan@jiwei"]').click()
  await expect(page.getByRole('button', { name: /安装 1 个并继续/ })).toBeVisible()
  await page.locator('[data-role-id="role-kaoyan@jiwei"]').click()
  await page.getByRole('button', { name: /先跳过/ }).click()
  await expect(page.getByText('康奈尔笔记法，三分钟上手')).toBeVisible()
  if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, '33-onboarding-3.png') })
  await page.getByRole('button', { name: '打开示例笔记' }).click()
  // 跳过了模型配置：顶部常驻提示，点开是同一个配置卡片
  await page.getByTestId('model-setup-banner').getByRole('button', { name: '1 分钟完成设置' }).click()
  await expect(page.getByTestId('model-setup')).toBeVisible()
  await page.keyboard.press('Escape')

  // 示例笔记：5 行康奈尔 + 总结
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('如何使用康奈尔笔记法')
  await expect(page.locator('.cornell-row')).toHaveCount(5)
  await expect(page.locator('.cornell-summary-content')).toContainText('用输出检验输入')
  const profile = await page.evaluate(() => window.jiwei.profile.get())
  expect(profile.name).toBe('小积')
  if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, '34-sample-note.png') })

  // 重启后不再出现引导，配色保留
  await app.close()
  app = await launch()
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await expect(page.getByRole('heading', { name: '欢迎来到积微' })).toHaveCount(0)
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'dunhuang')
  await app.close()
})
