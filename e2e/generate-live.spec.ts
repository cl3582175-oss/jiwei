import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChatMessage, Proposal } from '../src/shared/types'
import type { ChatSend } from '../src/shared/schemas'

// 生成技能（真实模型）：表格、图表、图示（含 Mermaid 校验）、时间线、代码分步讲解；交互演示只对强模型开放。
const source = process.env.JIWEI_IMPORT_PROVIDERS_FROM
test.skip(!source, '需要 JIWEI_IMPORT_PROVIDERS_FROM（真实服务商配置）')
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let providerId = ''
let model = ''
let noteId = ''
const shots = process.env.SHOTS_DIR

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-gen-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  const s = await page.evaluate(() => window.jiwei.settings.get())
  providerId = s.ai.chat.providerId!
  model = s.ai.chat.model!
  // 在界面中打开笔记（Mermaid 校验在渲染进程中进行）
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('生成实测')
  await page.keyboard.press('Enter')
  await page.keyboard.type('学习方法')
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '生成实测' }).then((n) => n.length))).toBeGreaterThan(0)
  noteId = await page.evaluate(() => window.jiwei.notes.list({ search: '生成实测' }).then((n) => n[0].id))
})
test.afterAll(async () => {
  await app?.close()
})

async function ask(text: string, opts: Partial<ChatSend> = {}): Promise<{ msg: ChatMessage; proposals: Proposal[] }> {
  const before = (await page.evaluate((id) => window.jiwei.proposals.list(id), noteId)).map((p) => p.id)
  const r = await page.evaluate((inp) => window.jiwei.chat.send(inp as never), {
    conversationId: null,
    providerId,
    model,
    effort: 'off',
    scope: { type: 'none' },
    context: { targets: [], noteId },
    text,
    ...opts
  })
  let msg: ChatMessage | undefined
  await expect
    .poll(
      async () => {
        msg = (await page.evaluate((cid) => window.jiwei.chat.messages(cid), r.conversation.id)).find((m) => m.id === r.assistantMessageId)
        return msg?.status
      },
      { timeout: 180_000, intervals: [1000] }
    )
    .not.toBe('streaming')
  expect(msg!.status, msg!.error ?? '').toBe('done')
  const proposals = (await page.evaluate((id) => window.jiwei.proposals.list(id), noteId)).filter((p) => !before.includes(p.id))
  return { msg: msg!, proposals }
}

const kinds = (ps: Proposal[]): string[] => ps.flatMap((p) => Object.values(p.embeds).map((e) => e.kind))

test('table', async () => {
  test.setTimeout(200_000)
  const { msg, proposals } = await ask('用表格对比间隔重复、提取练习、交错练习：做法、适合场景、注意事项。')
  expect(msg.steps.map((s) => s.tool)).toContain('note_add_table')
  expect(JSON.stringify(proposals)).toContain('"tableHeader"')
})

test('chart', async () => {
  test.setTimeout(200_000)
  const { msg, proposals } = await ask('画一个折线图：艾宾浩斯遗忘曲线，20 分钟 58%，1 小时 44%，1 天 34%，6 天 25%，31 天 21%。')
  expect(msg.steps.map((s) => s.tool)).toContain('note_add_chart')
  const chart = proposals.flatMap((p) => Object.values(p.embeds)).find((e) => e.kind === 'chart')!.data as {
    type: string
    series: { data: number[] }[]
  }
  expect(chart.type).toBe('line')
  expect(chart.series[0].data).toEqual([58, 44, 34, 25, 21])
})

test('diagram (Mermaid validated in the renderer)', async () => {
  test.setTimeout(200_000)
  const { msg, proposals } = await ask('画一个流程图：学习新知识 → 第二天自测 → 记得就把复习间隔加倍，忘了就当天重学并把间隔重置为 1 天。')
  expect(msg.steps.map((s) => s.tool)).toContain('note_add_diagram')
  expect(kinds(proposals)).toContain('diagram')
  const code = (proposals.flatMap((p) => Object.values(p.embeds)).find((e) => e.kind === 'diagram')!.data as { code: string }).code
  expect(await page.evaluate((c) => window.__jiweiValidate!('diagram', { code: c }), code)).toBeNull()
})

test('timeline', async () => {
  test.setTimeout(200_000)
  const { msg, proposals } = await ask(
    '做一个时间线：记忆研究的几个里程碑（1885 艾宾浩斯遗忘曲线、1932 巴特利特重构记忆、1972 加工层次理论、2006 测试效应研究）。'
  )
  expect(msg.steps.map((s) => s.tool)).toContain('note_add_timeline')
  expect(kinds(proposals)).toContain('timeline')
})

test('code walkthrough', async () => {
  test.setTimeout(200_000)
  const { msg, proposals } = await ask('用代码分步讲解二分查找：在 [1, 3, 5, 8, 13] 中找 8，展示每一步 lo、hi、mid 的变化。')
  expect(msg.steps.map((s) => s.tool)).toContain('note_add_code_steps')
  const steps = proposals.flatMap((p) => Object.values(p.embeds)).find((e) => e.kind === 'steps')!.data as { steps: unknown[] }
  expect(steps.steps.length).toBeGreaterThanOrEqual(3)
})

test('accept all and render', async () => {
  test.setTimeout(60_000)
  const accept = page.getByRole('button', { name: '全部接受' })
  for (let i = 0; i < 12 && (await accept.count()) > 0; i++) {
    await accept
      .first()
      .click({ timeout: 5000 })
      .catch(() => {})
    await page.waitForTimeout(300)
  }
  const doc = page.locator('.cornell-doc')
  await expect(doc.locator('table th').first()).toBeVisible()
  await expect(doc.locator('.chart-canvas svg')).toBeVisible({ timeout: 15_000 })
  await expect(doc.locator('.diagram-svg svg')).toBeVisible({ timeout: 15_000 })
  await expect(doc.locator('.timeline-item').first()).toBeVisible()
  await expect(doc.locator('.steps-line.is-on').first()).toBeVisible()
  if (shots) {
    await doc.locator('.embed-block[data-kind="diagram"]').scrollIntoViewIfNeeded()
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(shots, '105-live-generated.png') })
  }
})

test('interactive demos only with a strong model', async () => {
  test.setTimeout(300_000)
  // 弱模型：没有交互演示工具
  const weak = await ask('做一个交互演示：拖动滑块调整复习间隔，实时显示记忆保持率曲线。')
  expect(weak.msg.steps.map((s) => s.tool)).not.toContain('note_add_interactive')
  // 强模型（deepseek-v4-pro）
  const strong = await ask('做一个交互演示：拖动滑块调整复习间隔（1～10 天），实时显示 30 天内的记忆保持率曲线。', {
    model: 'deepseek-v4-pro'
  })
  expect(strong.msg.steps.map((s) => s.tool)).toContain('note_add_interactive')
  await page.getByRole('button', { name: '全部接受' }).first().click()
  const frame = page.frameLocator('.embed-block[data-kind="interactive"] iframe')
  await expect(frame.locator('input[type="range"]').first()).toBeVisible({ timeout: 15_000 })
  if (shots) {
    await page.locator('.embed-block[data-kind="interactive"]').scrollIntoViewIfNeeded()
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(shots, '106-live-interactive.png') })
  }
})
