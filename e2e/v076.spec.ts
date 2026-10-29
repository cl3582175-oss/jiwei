import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'http'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'
import { writeOpenAiCompletion } from './fixtures/openaiResponse'

// v0.7.6：知识库看得见（依据折叠、索引状态）、资料记笔记起始页、范围先问（选择题）与整份资料后台整理、
// 笔记列表菜单 / 多选 / 拖到分类、复习卡片库与自选复习、费曼练习首页。
// 受控模型：按用户消息走固定剧本；structured 请求按系统提示返回要点、导图或提纲。

test.describe.configure({ mode: 'serial' })
const shots = process.env.SHOTS_DIR
let app: ElectronApplication, page: Page, server: Server
let sourceId = ''
const seen: { lastUser: string; tools: string[] }[] = []

type Msg = { role: string; content?: unknown; tool_calls?: { function: { name: string } }[] }
const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? '').join('') : ''

/** 本轮（最后一条用户消息之后）已调用过的工具 */
function calledSince(messages: Msg[]): string[] {
  const i = messages.map((m) => m.role).lastIndexOf('user')
  return messages.slice(i + 1).flatMap((m) => (m.tool_calls ?? []).map((c) => c.function.name))
}

function script(messages: Msg[]): { call?: { name: string; args: unknown }; text?: string } {
  const lastUser = textOf(messages.filter((m) => m.role === 'user').at(-1)?.content)
  const all = messages.map((m) => textOf(m.content)).join('\n')
  const sid = /（ID：([0-9a-f-]{36})）/.exec(all)?.[1] ?? sourceId
  const done = calledSince(messages)
  if (/起草|导图/.test(lastUser)) {
    if (!done.includes('source_outline')) return { call: { name: 'source_outline', args: { sourceId: sid } } }
    if (!done.includes('ask_user'))
      return { call: { name: 'ask_user', args: { question: '要整理哪部分？', options: ['当前页', '整份资料'] } } }
    return { text: '要整理哪部分？' }
  }
  if (lastUser.includes('整份资料')) {
    if (!done.includes('source_digest')) return { call: { name: 'source_digest', args: { sourceId: sid, task: 'outline' } } }
    return { text: '已在后台开始整理。' }
  }
  if (lastUser.includes('间隔')) return { text: '间隔重复让复习落在快要遗忘的时候 [1]。' }
  return { text: '好的。' }
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const input = JSON.parse(body || '{}') as { stream?: boolean; messages: Msg[]; tools?: { function: { name: string } }[] }
      const system = textOf(input.messages.find((m) => m.role === 'system')?.content)
      const usage = { prompt_tokens: 3000, completion_tokens: 300, total_tokens: 3300 }
      // Digest map requests use Markdown text, before the structured outline reduce step.
      if (system.includes('每行写 - 要点 {片段ID}')) {
        const prompt = textOf(input.messages.filter((m) => m.role === 'user').at(-1)?.content)
        const ids = [...prompt.matchAll(/\[([0-9a-f-]{36})/g)].map((m) => m[1])
        if (!ids.length) return void res.writeHead(422).end('Digest fixture expected source segment IDs')
        const content = `# 学习方法\n- 间隔重复在快要遗忘时复习 {${ids[0]}}\n- 提取练习比重读有效 {${ids[1] ?? ids[0]}}`
        writeOpenAiCompletion(res, {
          id: 'digest-points',
          object: 'chat.completion',
          created: 1,
          model: 'deepseek-flash',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage
        }, !!input.stream)
        return
      }
      if (input.tools?.some((tool) => tool.function.name === 'submit')) {
        const prompt = textOf(input.messages.filter((m) => m.role === 'user').at(-1)?.content)
        const ids = [...prompt.matchAll(/\[([0-9a-f-]{36})/g)].map((m) => m[1])
        const id = ids[0] ?? /\{([0-9a-f-]{36})\}/.exec(prompt)?.[1] ?? ''
        const args = system.includes('提炼这一段')
          ? {
              topic: '学习方法',
              points: [
                { text: '间隔重复在快要遗忘时复习', segmentId: id },
                { text: '提取练习比重读有效', segmentId: ids[1] ?? id }
              ]
            }
          : system.includes('康奈尔笔记提纲')
            ? {
                rows: [
                  { cue: '什么是间隔重复？', body: '- 在快要遗忘的时候复习', segmentIds: [id] },
                  { cue: '为什么提取练习有效？', body: '- 主动回忆加强提取', segmentIds: [] }
                ]
              }
            : {}
        const call = { id: 's', type: 'function' as const, function: { name: 'submit', arguments: JSON.stringify(args) } }
        writeOpenAiCompletion(res, {
          id: 'r',
          object: 'chat.completion',
          created: 1,
          model: 'deepseek-flash',
          choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }],
          usage
        }, !!input.stream)
        return
      }
      const lastUser = textOf(input.messages.filter((m) => m.role === 'user').at(-1)?.content)
      seen.push({ lastUser, tools: calledSince(input.messages) })
      const next = script(input.messages)
      writeOpenAiCompletion(res, {
        id: 'c',
        object: 'chat.completion',
        created: 1,
        model: 'deepseek-flash',
        choices: [{
          index: 0,
          message: next.call
            ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call_${Date.now()}`,
                  type: 'function',
                  function: { name: next.call.name, arguments: JSON.stringify(next.call.args) }
                }
              ]
            }
            : { role: 'assistant', content: next.text ?? null },
          finish_reason: next.call ? 'tool_calls' : 'stop'
        }],
        usage
      }, !!input.stream)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-v076-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  // 一份 60 段的资料（足够长，触发“先问范围”）
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-v076-src-'))
  const file = join(dir, '学习方法.md')
  writeFileSync(
    file,
    [
      '# 学习方法',
      ...Array.from(
        { length: 60 },
        (_, i) => `第 ${i + 1} 段：间隔重复与提取练习是两种被反复验证的学习方法，交错练习也能帮助区分相似的问题，编号 ${i + 1}。`.repeat(8)
      )
    ].join('\n\n')
  )
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  sourceId = await page.evaluate(
    async ({ baseUrl, file }) => {
      const j = window.jiwei
      const p = await j.providers.save({ kind: 'ollama', name: '测试模型', baseUrl, models: ['deepseek-flash'] })
      const s = await j.settings.get()
      await j.settings.set({ ai: { ...s.ai, chat: { providerId: p.id, model: 'deepseek-flash' }, effort: 'off' } })
      const r = await j.sources.importPaths([file])
      return r.imported[0].id as string
    },
    { baseUrl, file }
  )
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.sources.indexStatus(id).then((s) => s.segments), sourceId), { timeout: 20_000 })
    .toBeGreaterThan(40)
  await page.reload()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((r) => server.close(() => r()))
})
const shot = async (name: string): Promise<void> => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}

test('从资料库打开资料：右边是记笔记起始页，不是上次的笔记；新建笔记自动关联，再打开时可以接着写', async () => {
  // 先打开一篇别的笔记
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('无关的旧笔记')
  await page.keyboard.press('Enter')
  await navTo(page, /资料库/)
  await page.getByText('学习方法', { exact: true }).first().dblclick()
  const start = page.getByTestId('source-start')
  await expect(start).toBeVisible()
  await expect(page.getByPlaceholder('笔记标题')).toHaveCount(0)
  // 资料标题下显示检索准备情况（测试环境没有本地向量模型：仅关键词检索）
  await expect(page.getByTestId('source-index')).toContainText(/仅关键词检索|已入知识库|语义索引/)
  await shot('v076-source-start')
  await start.getByRole('button', { name: '新建笔记' }).click()
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('《学习方法》笔记')
  await navTo(page, /资料库/)
  await page.getByText('学习方法', { exact: true }).first().dblclick()
  await expect(page.getByTestId('source-start-notes')).toContainText('《学习方法》笔记')
})

test('让 AI 起草：先看规模、用选择题问范围；选“整份资料”后确认预计费用，后台整理完成后提案进笔记', async () => {
  await page.getByTestId('source-start').getByRole('button', { name: '让 AI 起草提纲' }).click()
  // 先在起始页选范围；这里选“自己在对话里说”，让 AI 判断范围不明时用选择题问
  const scope = page.getByTestId('draft-scope')
  await expect(scope.getByRole('button', { name: /整份资料/ })).toBeVisible()
  await scope.getByRole('button', { name: '我自己在对话里说' }).click()
  await expect
    .poll(() => page.evaluate(() => (document.activeElement as HTMLTextAreaElement | null)?.value ?? ''))
    .toContain('起草笔记提纲')
  await page.keyboard.press('Enter')
  const choices = page.getByTestId('ask-choices')
  await expect(choices).toBeVisible({ timeout: 20_000 })
  expect(seen.some((s) => s.tools.includes('source_outline'))).toBe(true)
  await shot('v076-ask-choices')
  await choices.getByRole('button', { name: '整份资料' }).click()
  // 确认卡片：说明范围、批数与预计费用
  const approval = page.getByText(/把《学习方法》整份资料整理成康奈尔提纲/)
  await expect(approval).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/分 \d+ 批读取；预计费用/)).toBeVisible()
  await shot('v076-digest-confirm')
  await page.getByRole('button', { name: '允许' }).click()
  await expect(page.getByText(/的康奈尔提纲已做好/)).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '打开笔记' }).last().click()
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('《学习方法》康奈尔提纲')
  await expect(page.getByText('什么是间隔重复？').first()).toBeVisible()
})

test('回答下方的依据默认折叠成一行，展开后列出片段并标明怎么找到的', async () => {
  await navTo(page, /积微助手/)
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await page.getByRole('textbox', { name: '问积微，或交代一件事……' }).fill('间隔重复有什么用？')
  await page.keyboard.press('Enter')
  const basis = page.getByTestId('answer-basis').last()
  await expect(basis).toContainText(/依据 · 知识库 1 处/, { timeout: 20_000 })
  await expect(basis).toContainText(/关键词|语义|正在看的内容/)
  await expect(basis.getByText('学习方法')).toHaveCount(0)
  await basis.getByRole('button', { name: '展开依据' }).click()
  await expect(basis.getByText('学习方法').first()).toBeVisible()
  await shot('v076-basis')
})

test('笔记列表：⋯ 菜单与右键菜单置顶、移动；⌘ 多选后批量移动；拖到分类；删除可撤销', async () => {
  await navTo(page, /^笔记/, { again: true })
  const ids = await page.evaluate(async () => {
    const j = window.jiwei
    const cat = await j.categories.create('note', '考研', null)
    const out: string[] = []
    for (const title of ['甲笔记', '乙笔记', '丙笔记']) {
      const n = await j.notes.create({ title })
      out.push(n.id)
    }
    return { cat: cat.id, notes: out }
  })
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /^笔记/, { again: true })
  const close = page.getByRole('button', { name: '关闭资料' })
  if (await close.count()) await close.first().click()
  const row = (title: string) => page.locator('[data-note-id]').filter({ hasText: title }).first()
  await row('甲笔记').hover()
  await row('甲笔记').getByRole('button', { name: '笔记操作' }).click()
  await page.getByRole('menuitem', { name: '置顶' }).click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.notes.get(id).then((n) => n?.pinned), ids.notes[0])).toBe(true)
  // 右键 → 移动到
  await row('乙笔记').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '移动到' }).hover()
  await page.getByRole('menuitem', { name: '考研' }).click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.notes.get(id).then((n) => n?.categoryId), ids.notes[1])).toBe(ids.cat)
  // ⌘ 多选 → 批量移动到未分类
  await expect(page.getByRole('menu')).toHaveCount(0)
  // 打开甲，再 ⌘ 点乙：两篇都选中（与访达相同，⌘ 点选包含当前这篇）
  await row('甲笔记').click()
  await row('乙笔记').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
  const bulk = page.getByTestId('notes-bulk')
  await expect(bulk).toContainText('已选 2 篇')
  await shot('v076-notes-bulk')
  await bulk.getByRole('button', { name: '移动到' }).click()
  await page.getByRole('menuitem', { name: '未分类' }).click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.notes.get(id).then((n) => n?.categoryId), ids.notes[1])).toBe(null)
  // 拖到分类
  await row('丙笔记').dragTo(page.getByRole('button', { name: '考研' }).first())
  await expect.poll(() => page.evaluate((id) => window.jiwei.notes.get(id).then((n) => n?.categoryId), ids.notes[2])).toBe(ids.cat)
  // 删除可撤销
  await row('丙笔记').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '删除' }).click()
  await page.getByRole('button', { name: '删除' }).last().click()
  await expect(page.locator('[data-note-id]').filter({ hasText: '丙笔记' })).toHaveCount(0)
  await page.getByRole('button', { name: '撤销' }).click()
  await expect(row('丙笔记')).toBeVisible()
})

test('复习：卡片库列出全部卡片，勾选后自选复习；没到期的只算练习，不改变复习时间', async () => {
  const noteId = await page.evaluate(async () => (await window.jiwei.notes.create({ title: '记忆方法' })).id)
  const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
  await page.evaluate(({ noteId, ops }) => window.jiwei.proposals.create({ noteId, title: '整理', ops }), {
    noteId,
    ops: ['什么是间隔重复？', '提取练习为什么有效？', '交错练习适合什么场景？'].map((q) => ({
      op: 'insert_row' as const,
      afterRowId: null,
      cue: [p(q)],
      body: [p('答案')]
    }))
  })
  // 提案要在编辑器里接受
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /^笔记/, { again: true })
  await page.locator('[data-note-id]').filter({ hasText: '记忆方法' }).first().click()
  await page.getByRole('button', { name: '全部接受' }).click()
  await expect
    .poll(() => page.evaluate(() => window.jiwei.review.stats().then((s) => s.total)), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(3)
  await navTo(page, /复习/)
  await page.getByRole('tab', { name: '卡片' }).click()
  const lib = page.getByTestId('card-library')
  await lib.getByRole('radio', { name: '全部' }).click()
  await expect(lib.getByTestId('card-row')).toHaveCount(3)
  await lib.getByRole('radio', { name: '新卡片' }).click()
  await lib.getByRole('checkbox', { name: '什么是间隔重复？' }).check()
  await lib.getByRole('checkbox', { name: '交错练习适合什么场景？' }).check()
  await shot('v076-card-library')
  await lib.getByTestId('cards-start').click()
  await expect(page.getByTestId('review-queue')).toContainText('第 1 / 2 张')
  await expect(page.getByTestId('review-question')).toContainText('什么是间隔重复？')
  const before = await page.evaluate(() => window.jiwei.review.list('all').then((cs) => cs.map((c) => [c.id, c.due, c.state])))
  await page.getByRole('button', { name: '显示答案' }).click()
  await page.getByRole('button', { name: /^记得/ }).click()
  await expect(page.getByTestId('review-question')).toContainText('交错练习适合什么场景？')
  await page.getByRole('button', { name: '显示答案' }).click()
  await page.getByRole('button', { name: /^记得/ }).click()
  await expect(page.getByText('这一组复习完了')).toBeVisible()
  await expect(page.getByText(/其中 2 张是练习/)).toBeVisible()
  const after = await page.evaluate(() => window.jiwei.review.list('all').then((cs) => cs.map((c) => [c.id, c.due, c.state])))
  expect(after).toEqual(before)
  await page.getByRole('button', { name: '回到卡片库' }).click()
  await expect(page.getByTestId('card-library')).toBeVisible()
  // 今日复习前可以先看清单
  await page.getByRole('tab', { name: '今日复习' }).click()
})

test('v0.7.7 今日复习：先看清单可取消勾选；复习中可以跳到清单里的某一张或跳过；做完回到清单', async () => {
  await page.getByRole('tab', { name: '今日复习' }).click()
  const plan = page.getByTestId('review-plan')
  await expect(plan.getByTestId('plan-row')).toHaveCount(3)
  await shot('v077-review-plan')
  await plan.getByRole('checkbox', { name: '提取练习为什么有效？' }).uncheck()
  await expect(page.getByTestId('plan-start')).toContainText('开始复习（2 张）')
  await page.getByTestId('plan-start').click()
  const bar = page.getByTestId('review-queue')
  await expect(bar).toContainText('今日复习')
  await expect(page.getByTestId('queue-progress')).toContainText('第 1 / 2 张')
  await expect(page.getByTestId('review-question')).toContainText('什么是间隔重复？')
  // 跳到清单里的第 2 张
  await page.getByTestId('queue-progress').click()
  await page
    .getByTestId('queue-list')
    .getByRole('button', { name: /交错练习适合什么场景？/ })
    .click()
  await expect(page.getByTestId('review-question')).toContainText('交错练习适合什么场景？')
  await shot('v077-review-jump')
  // 跳过这张：留在今天的待复习里
  await bar.getByRole('button', { name: '跳过这张' }).click()
  await expect(page.getByTestId('review-question')).toContainText('什么是间隔重复？')
  // 新卡片评“轻松”直接进入复习阶段（评“记得”会在 10 分钟后再出现一次，属于正常的学习步骤）
  await page.getByRole('button', { name: '显示答案' }).click()
  await page.getByRole('button', { name: /^轻松/ }).click()
  await expect(page.getByTestId('review-done')).toContainText('这次复习了 1 张')
  await expect(page.getByRole('button', { name: '还想再练？去卡片库挑几张' })).toBeVisible()
  await page.getByRole('button', { name: '回到今日清单' }).click()
  await expect(page.getByTestId('review-plan').getByText('交错练习适合什么场景？')).toBeVisible()
  // 只复习某篇笔记的
  await page
    .getByTestId('review-plan')
    .getByRole('button', { name: /只复习这篇/ })
    .first()
    .click()
  await expect(page.getByTestId('review-queue')).toBeVisible()
  await page.getByRole('button', { name: '回到今日清单' }).click()
})

test('费曼练习：从导航进入是首页（推荐的概念、练过的），不再是空白页', async () => {
  await navTo(page, /费曼/)
  const home = page.getByTestId('feynman-home')
  await expect(home).toBeVisible()
  await expect(page.getByTestId('feynman-suggestions')).toContainText(/记忆方法|学习方法/)
  await shot('v076-feynman-home')
  await home.getByRole('textbox', { name: '想讲清楚哪个概念？' }).fill('机会成本')
  await home.getByRole('button', { name: '开始讲' }).click()
  await expect(page.getByRole('heading', { name: '把「机会成本」讲给小微听' })).toBeVisible()
  await page.getByRole('button', { name: '全部练习' }).click()
  await expect(page.getByTestId('feynman-home')).toBeVisible()
})
