import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 智能体界面（不需要 API Key）：技能、记忆（关于我）、无痕对话
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
const shots = process.env.SHOTS_DIR

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-agent-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

const openSettings = async (tab: string): Promise<void> => {
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('dialog').getByRole('button', { name: tab, exact: true }).click()
}

test('skills: built-in list, view, disable', async () => {
  const list = await page.evaluate(() => window.jiwei.skills.list())
  expect(list.map((s) => s.name)).toEqual(
    expect.arrayContaining([
      'explain-concept',
      'clarify-passage',
      'mindmap',
      'cornell-cues',
      'summarize-note',
      'revise-text',
      'knowledge-synthesis'
    ])
  )
  expect(list.every((s) => s.enabled && s.source === 'builtin')).toBe(true)

  await openSettings('技能')
  await expect(page.getByText('解释概念', { exact: true })).toBeVisible()
  // 展开查看 SKILL.md
  await page.getByRole('button', { name: /思维导图/ }).click()
  await expect(page.getByText(/好的导图是\*\*结构\*\*/)).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, '71-skills.png') })
  // 停用后持久化
  await page.getByRole('switch', { name: '思维导图' }).click()
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.skills.list())).find((s) => s.name === 'mindmap')?.enabled)
    .toBe(false)
  await page.getByRole('switch', { name: '思维导图' }).click()
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.skills.list())).find((s) => s.name === 'mindmap')?.enabled)
    .toBe(true)
})

test('about me: profile and memories', async () => {
  await page.getByRole('dialog').getByRole('button', { name: '关于我', exact: true }).click()
  await expect(page.getByText('积微记住的')).toBeVisible()
  await expect(page.getByText(/还没有记忆/)).toBeVisible()
  // 个人档案：失焦即保存
  const role = page.getByRole('textbox', { name: '我是' })
  await role.fill('大三计算机专业学生，准备考研')
  await page.getByRole('textbox', { name: '回答偏好' }).click()
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.memory.profile())).role).toBe('大三计算机专业学生，准备考研')

  // 手动添加一条记忆
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('textbox').fill('喜欢先看结论，再看推导过程')
  await page.getByRole('alertdialog').getByRole('button', { name: '保存' }).click()
  await expect(page.getByText('喜欢先看结论，再看推导过程')).toBeVisible()
  await expect(page.getByText(/你添加/)).toBeVisible()

  // AI 记下的敏感内容：待确认 → 确认
  const pending = await page.evaluate(() =>
    window.jiwei.memory.save({ kind: 'fact', content: '正在接受焦虑症治疗', sensitive: true, status: 'pending' })
  )
  await expect(page.getByText('等待你确认')).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, '72-about-me.png') })
  await page.getByRole('button', { name: '记住', exact: true }).click()
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.memory.list({}))).find((m) => m.id === pending.id)?.status)
    .toBe('active')

  // 删除
  const row = page.getByRole('listitem').filter({ hasText: '正在接受焦虑症治疗' })
  await row.hover()
  await row.getByRole('button', { name: '删除' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除' }).click()
  await expect(page.getByText('正在接受焦虑症治疗')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('memory lives in the personal database, not the knowledge base', async () => {
  const list = await page.evaluate(() => window.jiwei.memory.list({}))
  expect(list.some((m) => m.content.includes('先看结论'))).toBe(true)
  // 切换 / 新建知识库不影响记忆：记忆库位于用户目录
  const info = await page.evaluate(() => window.jiwei.app.info())
  expect(JSON.stringify(info)).not.toContain('memory.db')
})

test('chat: incognito toggle for a new conversation', async () => {
  await page.getByRole('button', { name: /AI 对话/ }).click()
  const sw = page.getByRole('switch', { name: '无痕' })
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await sw.click()
  await expect(sw).toHaveAttribute('aria-checked', 'true')
})
