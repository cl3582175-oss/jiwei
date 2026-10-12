import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'

// 角色工具包（v0.10）：设置里多选角色 → 合并确认 → 今日起步卡 → 四种起步动作只预填不发送 → 关闭后重启不再出现
test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page
const userData = mkdtempSync(join(tmpdir(), 'jiwei-e2e-roles-'))
const exportDir = mkdtempSync(join(tmpdir(), 'jiwei-e2e-roles-export-'))
const launch = async (): Promise<void> => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_TEST_EXPORT_DIR: exportDir }
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

const pluginsSettings = async (tab: '角色' | '市场' | '已安装'): Promise<void> => {
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('button', { name: '插件', exact: true }).click()
  await page.getByRole('group', { name: '插件', exact: true }).getByRole('button', { name: tab, exact: true }).click()
}

test('customize copies an installed role into an editable folder, turns the original off, and reloads edits on update', async () => {
  await pluginsSettings('已安装')
  await page.locator('[data-plugin-id="role-kaoyan@jiwei"]').getByRole('button', { name: '管理', exact: true }).click()
  await page.getByTestId('plugin-details').getByRole('button', { name: '自定义', exact: true }).click()
  const confirm = page.getByTestId('plugin-confirm')
  await expect(confirm).toContainText('考研（自定义）')
  await confirm.getByRole('button', { name: '安装', exact: true }).click()
  await expect(confirm).toHaveCount(0)
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.plugins.list())).map((p) => `${p.id}:${p.enabled}`).sort())
    .toContain('role-kaoyan-custom@local:true')
  const list = await page.evaluate(() => window.jiwei.plugins.list())
  expect(list.find((p) => p.id === 'role-kaoyan@jiwei')?.enabled).toBe(false)
  expect(list.find((p) => p.id === 'role-kaoyan-custom@local')?.authored).toBe('role-kaoyan-custom')
  const skills = await page.evaluate(() => window.jiwei.skills.list())
  expect(skills.some((s) => s.name === 'role-kaoyan-custom:kaoyan-paper-review')).toBe(true)
  expect(skills.some((s) => s.name === 'role-kaoyan:kaoyan-paper-review')).toBe(false)
  // 改文件夹里的模板，点“更新”重新载入
  const file = join(userData, 'plugins/authoring/role-kaoyan-custom/jiwei/templates/kaoyan-framework.json')
  const tpl = JSON.parse(readFileSync(file, 'utf8'))
  tpl.title.zh = '数学知识框架'
  writeFileSync(file, JSON.stringify(tpl))
  await page.locator('[data-plugin-id="role-kaoyan-custom@local"]').getByRole('button', { name: '管理', exact: true }).click()
  await expect(page.getByTestId('plugin-details').getByRole('button', { name: '编辑文件夹', exact: true })).toBeVisible()
  await page.getByTestId('plugin-details').getByRole('button', { name: '更新', exact: true }).click()
  await page
    .getByTestId('plugin-confirm')
    .getByRole('button', { name: /安装|更新/ })
    .last()
    .click()
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.plugins.templates())).map((x) => x.title.zh))
    .toContain('数学知识框架')
  await page.keyboard.press('Escape')
})

test('new role pack from existing skills and tasks installs through the normal confirmation', async () => {
  await page.evaluate(() =>
    window.jiwei.tasks.save({
      name: '晚间回顾',
      instruction: '读今天的笔记，出三道回忆题。',
      trigger: { type: 'schedule', every: 'day', time: '21:00' },
      tools: ['note_find', 'note_read', 'note_create'],
      outputs: { inbox: true },
      enabled: false
    } as never)
  )
  await pluginsSettings('角色')
  await page.getByRole('button', { name: '新建角色包', exact: true }).click()
  const dialog = page.getByTestId('new-role-pack')
  await dialog.getByLabel('名称').fill('我的复习包')
  await dialog.getByLabel('费曼练习').check()
  await dialog.getByLabel('晚间回顾').check()
  await dialog.getByRole('button', { name: '生成', exact: true }).click()
  const confirm = page.getByTestId('plugin-confirm')
  await expect(confirm).toContainText('我的复习包')
  await confirm.getByRole('button', { name: '安装', exact: true }).click()
  await expect(confirm).toHaveCount(0)
  const mine = (await page.evaluate(() => window.jiwei.plugins.list())).find((p) => p.manifest.displayName === '我的复习包')!
  expect(mine.authored).toMatch(/^my-role-/)
  const recipes = await page.evaluate(() => window.jiwei.tasks.recipes())
  const recipe = recipes.find((r) => r.pluginId === mine.id)!
  // 写入类工具不进配方，配方默认关闭
  expect(recipe.task.tools).toEqual(['note_find', 'note_read'])
  expect(recipe.task.enabled).toBe(false)
  await expect(page.locator(`[data-role-id="${mine.id}"]`)).toBeVisible()
  await page.keyboard.press('Escape')
})

test('export writes a Claude Code plugin folder, zip and optional marketplace', async () => {
  await pluginsSettings('已安装')
  await page.locator('[data-plugin-id="role-research@jiwei"]').getByRole('button', { name: '管理', exact: true }).click()
  await page.getByTestId('plugin-details').getByRole('button', { name: '导出为插件', exact: true }).click()
  const dialog = page.getByTestId('plugin-export')
  await dialog.getByRole('checkbox').check()
  await app.evaluate(({ shell }) => {
    shell.showItemInFolder = () => undefined
  })
  await dialog.getByRole('button', { name: '选择保存位置', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const root = join(exportDir, 'role-research-marketplace')
  const market = JSON.parse(readFileSync(join(root, '.claude-plugin/marketplace.json'), 'utf8'))
  expect(market.plugins).toEqual([expect.objectContaining({ name: 'role-research', source: './plugins/role-research' })])
  expect(existsSync(join(root, 'plugins/role-research/.claude-plugin/plugin.json'))).toBe(true)
  expect(existsSync(join(root, 'plugins/role-research/skills/paper-reading/SKILL.md'))).toBe(true)
  expect(existsSync(`${root}.zip`)).toBe(true)
  await page.keyboard.press('Escape')
})
