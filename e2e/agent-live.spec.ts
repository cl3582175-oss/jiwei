import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChatMessage } from '../src/shared/types'
import type { ChatSend } from '../src/shared/schemas'
import { navTo } from './fixtures/nav'

// 真实模型下的智能体：记忆、无痕、技能 + 上下文包、工具调用生成提案。
// 运行：JIWEI_IMPORT_PROVIDERS_FROM=<应用数据库路径> npx playwright test e2e/agent-live.spec.ts
const source = process.env.JIWEI_IMPORT_PROVIDERS_FROM
test.skip(!source, '需要 JIWEI_IMPORT_PROVIDERS_FROM（真实服务商配置）')
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let providerId = ''
let model = ''
let noteId = ''
let sourceId = ''
const shots = process.env.SHOTS_DIR

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-agent-live-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

/** 直接调用对话接口并等待完成（用于精确控制上下文包与技能） */
async function chat(input: Partial<ChatSend> & { text: string }): Promise<ChatMessage> {
  const r = await page.evaluate((inp) => window.jiwei.chat.send(inp as never), {
    conversationId: null,
    providerId,
    model,
    effort: 'off',
    scope: { type: 'all' },
    ...input
  })
  let msg: ChatMessage | undefined
  await expect
    .poll(
      async () => {
        const list = await page.evaluate((cid) => window.jiwei.chat.messages(cid), r.conversation.id)
        msg = list.find((m) => m.id === r.assistantMessageId)
        return msg?.status
      },
      { timeout: 150_000, intervals: [1000] }
    )
    .not.toBe('streaming')
  expect(msg!.status, msg!.error ?? '').toBe('done')
  return msg!
}

test('setup: provider, knowledge base, note', async () => {
  test.setTimeout(180_000)
  const s = await page.evaluate(() => window.jiwei.settings.get())
  providerId = s.ai.chat.providerId!
  model = s.ai.chat.model!
  expect(providerId && model).toBeTruthy()
  await page.evaluate(() => window.jiwei.embedding.installLocal())
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-agent-src-'))
  writeFileSync(
    join(dir, '学习科学.md'),
    [
      '# 学习科学的关键方法',
      '',
      '## 间隔重复',
      '',
      '学习后 20 分钟遗忘约 42%，一天后遗忘约 66%。在快要遗忘的时候复习，记忆保持最久。复习间隔应逐渐拉长，例如 1 天、3 天、7 天、15 天。',
      '',
      '## 提取练习',
      '',
      '主动回忆比反复阅读更有效。合上书，尝试写下或说出刚学的内容，这个“提取”过程本身就会强化记忆，这被称为测试效应。',
      '',
      '## 交错练习',
      '',
      '把不同类型的题目混在一起练习，而不是一种题做完再做下一种。交错练习短期内感觉更难，但长期迁移效果更好，这是一种“合意困难”。'
    ].join('\n')
  )
  const imported = await page.evaluate((p) => window.jiwei.sources.importPaths([p]), join(dir, '学习科学.md'))
  sourceId = imported.imported[0].id
  const note = await page.evaluate(() => window.jiwei.notes.create({ title: '学习方法笔记' }))
  noteId = note.id
  await expect
    .poll(
      async () => {
        const st = await page.evaluate(() => window.jiwei.embedding.status())
        const segs = await page.evaluate((id) => window.jiwei.segments.list(id), sourceId)
        return st.total > 0 && st.indexed === st.total && segs.length > 0
      },
      { timeout: 120_000 }
    )
    .toBe(true)
})

test('remember: explicit request is saved as a memory with an undo toast', async () => {
  test.setTimeout(150_000)
  await navTo(page, /AI 对话/)
  await page.getByRole('radio', { name: '关闭' }).click()
  await page.getByRole('textbox', { name: '问积微，或交代一件事……' }).fill('请记住：我是准备考研的大三学生，回答时请先给结论，再给推导。')
  await page.keyboard.press('Enter')
  await expect(page.getByText('积微记住了').first()).toBeVisible({ timeout: 120_000 })
  if (shots) await page.screenshot({ path: join(shots, '73-remembered.png') })
  const list = await page.evaluate(() => window.jiwei.memory.list({}))
  expect(list.some((m) => m.origin === 'ai' && /结论/.test(m.content))).toBe(true)
  // 回答语言跟随界面语言（中文）
  await expect(page.locator('.group\\/msg').last().locator('.chat-md')).toContainText(/[\u4e00-\u9fa5]/, { timeout: 30_000 })
  // 步骤中显示“记住”
  await expect(
    page
      .locator('.group\\/msg')
      .last()
      .getByText(/执行了 \d+ 步/)
  ).toBeVisible({ timeout: 30_000 })
})

test('incognito: no memory tools, nothing remembered', async () => {
  test.setTimeout(150_000)
  const before = (await page.evaluate(() => window.jiwei.memory.list({}))).length
  const m = await chat({ text: '请记住：我最喜欢的颜色是绿色。', incognito: true, scope: { type: 'none' } })
  expect(m.steps.some((s) => s.tool.startsWith('memory_'))).toBe(false)
  // 告诉用户无痕对话不会记住
  expect(m.content).toMatch(/无痕/)
  expect((await page.evaluate(() => window.jiwei.memory.list({}))).length).toBe(before)
})

test('skill + context packet: explain a selected concept in place', async () => {
  test.setTimeout(150_000)
  const segs = await page.evaluate((id) => window.jiwei.segments.list(id), sourceId)
  const seg = segs.find((s) => s.text.includes('合意困难'))!
  const m = await chat({
    text: '解释一下这个概念',
    skill: 'explain-concept',
    context: {
      targets: [{ kind: 'source-text', parentType: 'source', parentId: sourceId, ownerId: seg.id, quote: '合意困难' }],
      sourceId
    }
  })
  expect(m.skill).toBe('explain-concept')
  // 按技能规定的结构回答，并结合了语境（交错练习）
  expect(m.content).toMatch(/一句话/)
  expect(m.content).toMatch(/交错/)
})

test('agent: mind map from a source becomes a proposal in the note', async () => {
  test.setTimeout(240_000)
  const m = await chat({
    text: '根据这份资料，在我的笔记里画一张思维导图。',
    context: { targets: [], noteId, sourceId, viewport: { kind: 'viewport', parentType: 'source', parentId: sourceId } }
  })
  expect(m.steps.map((s) => s.tool)).toContain('note_add_mindmap')
  const proposals = await page.evaluate((id) => window.jiwei.proposals.list(id), noteId)
  const p = proposals.find((x) => x.ops.some((o) => o.op === 'insert_row' && JSON.stringify(o.body).includes('mindmap')))
  expect(p).toBeTruthy()
  const data = Object.values(p!.embeds)[0].data as { nodes: Record<string, { text: string; anchor?: { id: string } }> }
  const nodes = Object.values(data.nodes)
  expect(nodes.length).toBeGreaterThanOrEqual(5)
  // 导图节点挂到资料原文
  expect(nodes.some((n) => n.anchor?.id)).toBe(true)
  expect(nodes.every((n) => n.text.length <= 30)).toBe(true)

  // 在笔记中接受提案：导图出现在编辑器中，节点可回到原文
  // 笔记由接口创建，界面列表需刷新
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /^笔记/)
  await page.getByText('学习方法笔记').first().click()
  await expect(page.locator('.proposal-embed-live, .proposal-embed').first()).toBeVisible({ timeout: 15_000 })
  if (shots) await page.screenshot({ path: join(shots, '75-agent-mindmap-proposal.png') })
  await page.getByRole('button', { name: '全部接受' }).first().click()
  await expect(page.locator('.embed-block[data-kind="mindmap"] svg.mindmap-svg')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('svg.mindmap-svg .markmap-node').first()).toBeAttached()
  await page.locator('svg.mindmap-svg').scrollIntoViewIfNeeded()
  await page.waitForTimeout(800)
  if (shots) await page.screenshot({ path: join(shots, '76-agent-mindmap.png') })
})

test('agent: cue questions and summary on an existing note', async () => {
  test.setTimeout(240_000)
  const m1 = await chat({
    text: '在这篇笔记里新增两行：一行写“提取练习”的要点，一行写“交错练习”的要点，线索栏留空。',
    context: { targets: [], noteId }
  })
  expect(m1.steps.map((s) => s.tool)).toContain('note_add_rows')
  const proposals = await page.evaluate((id) => window.jiwei.proposals.list(id), noteId)
  const rows = proposals.find((p) => p.ops.every((o) => o.op === 'insert_row') && p.ops.length >= 2)
  expect(rows).toBeTruthy()
  await expect(page.getByRole('button', { name: '全部接受' }).first()).toBeVisible({ timeout: 15_000 })
  await page.getByRole('button', { name: '全部接受' }).first().click()
  await expect(page.locator('.cornell-row')).toHaveCount(3, { timeout: 15_000 })

  // 线索栏为空的行：生成线索问题（技能 cornell-cues → note_set_cues）
  const m2 = await chat({ text: '给这篇笔记生成线索问题。', context: { targets: [], noteId } })
  expect(m2.steps.map((s) => s.tool)).toContain('note_set_cues')
  // 总结
  const m3 = await chat({ text: '给这篇笔记写总结。', context: { targets: [], noteId } })
  expect(m3.steps.map((s) => s.tool)).toContain('note_set_summary')
  await expect(page.getByRole('button', { name: '全部接受' }).first()).toBeVisible({ timeout: 15_000 })
  if (shots) await page.screenshot({ path: join(shots, '74-agent-cues-proposal.png') })
})
