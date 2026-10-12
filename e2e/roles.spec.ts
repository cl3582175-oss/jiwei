import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'

// 角色工具包（v0.10）：设置里多选角色 → 合并确认 → 今日起步卡 → 四种起步动作只预填不发送 → 关闭后重启不再出现
test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page
const userData = mkdtempSync(join(tmpdir(), 'jiwei-e2e-roles-'))
const launch = async (): Promise<void> => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
}
const shot = async (name: string): Promise<void> => {
  if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, `${name}.png`) })
}
const starters = () => page.getByTestId('role-starters')
const today = async (): Promise<void> => {
  await navTo(page, /^今日/)
  await expect(page.getByTestId('today-view')).toBeVisible()
}

test.beforeAll(launch)
test.afterAll(async () => {
  await app?.close()
})

test('settings roles: grouped cards, multi-select, combined confirmation installs both packs', async () => {
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('button', { name: '插件', exact: true }).click()
  // 没有装过插件时先看角色
  await expect(page.getByTestId('roles-panel')).toBeVisible()
  await expect(page.getByRole('heading', { name: '我是学生' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '我在工作' })).toBeVisible()
  await expect(page.locator('[data-role-id]')).toHaveCount(8)
  for (const id of ['kaoyan', 'research', 'manager']) await page.locator(`[data-role-id="role-${id}@jiwei"]`).click()
  await expect(page.locator('[data-role-id="role-kaoyan@jiwei"]')).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: '安装所选（3）' }).click()
  const confirm = page.getByTestId('role-batch-confirm')
  await expect(confirm.locator('[data-role-preview]')).toHaveCount(3)
  await expect(confirm.locator('[data-role-preview="role-kaoyan@jiwei"]')).toContainText('考研')
  await expect(confirm.locator('[data-role-preview="role-kaoyan@jiwei"]')).toContainText('只包含文字内容')
  await expect(confirm).toContainText('AI 任务装好后默认关闭')
  await shot('roles-confirm')
  // 订阅源可以逐个取消
  await confirm.locator('[data-role-preview="role-manager@jiwei"]').getByRole('checkbox').first().uncheck()
  await confirm.getByRole('button', { name: '安装', exact: true }).click()
  await expect(confirm).toHaveCount(0)
  const list = await page.evaluate(() => window.jiwei.plugins.list())
  expect(list.map((p) => p.id).sort()).toEqual(['role-kaoyan@jiwei', 'role-manager@jiwei', 'role-research@jiwei'])
  // 任务配方只是配方，不会自动建任务
  expect(await page.evaluate(() => window.jiwei.tasks.list())).toHaveLength(0)
  const feeds = await page.evaluate(() => window.jiwei.discover.feeds())
  expect(feeds.filter((f) => f.pluginId === 'role-manager@jiwei')).toHaveLength(0)
  expect(feeds.filter((f) => f.pluginId === 'role-kaoyan@jiwei').length).toBeGreaterThan(0)
  // 已装的角色显示“已启用”，不能再选
  await expect(page.locator('[data-role-id="role-kaoyan@jiwei"]')).toContainText('已启用')
  // 插件内容用中文名展示，不露出内部 ID
  const skills = await page.evaluate(() => window.jiwei.skills.list())
  expect(skills.some((s) => s.name === 'role-kaoyan:kaoyan-paper-review' && s.title === '真题复盘')).toBe(true)
  await page.keyboard.press('Escape')
})

test('today shows the latest role starters; others fold away', async () => {
  await today()
  await expect(starters()).toHaveCount(1)
  await expect(starters().locator('[data-starter-id]')).toHaveCount(3)
  await expect(page.getByRole('button', { name: /还有 2 个角色的起步建议/ })).toBeVisible()
  await shot('roles-today')
  await page.getByRole('button', { name: /还有 2 个角色的起步建议/ }).click()
  await expect(starters()).toHaveCount(3)
})

test('advisor starter selects the framework and fills the question without submitting', async () => {
  await page.locator('[data-starter-id="role-kaoyan:first-school-choice"]').click()
  await expect(page.getByLabel('用分析框架')).toHaveValue('role-kaoyan:kaoyan-school-choice')
  await expect(page.getByRole('textbox', { name: '参谋' })).toHaveValue(/考研择校/)
  expect(await page.evaluate(() => window.jiwei.advisor.list())).toHaveLength(0)
  // 来源标签显示角色名
  await expect(page.getByRole('button', { name: '考研', exact: true }).first()).toBeVisible()
})

test('chat starter fills the composer but does not send', async () => {
  await today()
  await page.getByRole('button', { name: /还有 2 个角色的起步建议/ }).click()
  await page.locator('[data-starter-id="role-kaoyan:first-paper-review"]').click()
  await expect(page.locator('textarea').last()).toHaveValue(/考研真题/)
  expect(await page.evaluate(() => window.jiwei.chat.conversations())).toHaveLength(0)
})

test('work starter opens new work with the template; recipe starter opens the task form disabled', async () => {
  await today()
  await page.getByRole('button', { name: /还有 2 个角色的起步建议/ }).click()
  await page.locator('[data-starter-id="role-research:first-meeting"]').click()
  const dialog = page.getByTestId('new-work-dialog')
  await expect(dialog.getByLabel('作品模板')).toHaveValue('role-research:research-group-meeting')
  await expect(dialog.getByLabel('选题')).toHaveValue('')
  await expect(dialog).toContainText('需要导师决定的事')
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => window.jiwei.works.list())).toHaveLength(0)
  await today()
  await page.locator('[data-starter-id="role-manager:monday-decisions"]').click()
  await expect(page.getByLabel('任务名称')).toHaveValue('周一决策清单')
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => window.jiwei.tasks.list())).toHaveLength(0)
})

test('completed starters stay checked; dismissing persists across restart', async () => {
  await today()
  await page.getByRole('button', { name: /还有 2 个角色的起步建议/ }).click()
  const kaoyan = page.locator('[data-plugin-id="role-kaoyan@jiwei"]')
  await expect(kaoyan.locator('[data-starter-id="role-kaoyan:first-school-choice"]')).toHaveClass(/opacity-60/)
  await kaoyan.getByRole('button', { name: '不再显示' }).click()
  await expect(kaoyan).toHaveCount(0)
  await app.close()
  await launch()
  await today()
  await expect(page.locator('[data-plugin-id="role-kaoyan@jiwei"][data-testid="role-starters"]')).toHaveCount(0)
  await expect(page.locator('[data-plugin-id="role-manager@jiwei"][data-testid="role-starters"]')).toBeVisible()
})
