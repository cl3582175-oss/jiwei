import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'child_process'
import { createServer, type Server } from 'http'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { navTo } from './fixtures/nav'

// v0.7：助手办事（确认卡片）、外部 MCP 工具（策略、污点、OAuth）、费用记账与上限、设置页。
// 受控模型：按用户消息里的标记走固定剧本，按已有的工具结果决定下一步；每次流式响应都带 token 用量。

const shots = process.env.SHOTS_DIR
const FIXTURE = resolve('e2e/fixtures/mcp-test-server.mjs')
let app: ElectronApplication,
  page: Page,
  provider: Server,
  oauthServer: ChildProcess | null = null
const memo = join(mkdtempSync(join(tmpdir(), 'jiwei-agent-memo-')), 'memo.txt')
const requests: { tools: string[]; lastUser: string }[] = []

type Msg = { role: string; content?: unknown; tool_calls?: unknown[] }
const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? '').join('') : ''

function script(messages: Msg[]): { call?: { name: string; args: unknown }; text?: string } {
  const lastUser = messages
    .map((m, i) => [m, i] as const)
    .filter(([m]) => m.role === 'user')
    .at(-1)!
  const after = messages.slice(lastUser[1] + 1)
  const step = after.filter((m) => m.role === 'assistant' && m.tool_calls?.length).length
  const results = after.filter((m) => m.role === 'tool').map((m) => textOf(m.content))
  const last = results.at(-1) ?? ''
  const user = textOf(lastUser[0].content)
  if (user.includes('【建行动项】')) {
    if (step === 0) return { call: { name: 'action_create', args: { title: '重做第三章错题', due: '2026-10-17' } } }
    return { text: /拒绝|没有及时/.test(last) ? '好的，没有创建。' : '已经加好了，周五前完成。' }
  }
  if (user.includes('【出卷子】')) {
    if (step === 0) return { call: { name: 'mistakes_list', args: { days: 30 } } }
    if (step === 1)
      return {
        call: {
          name: 'note_create',
          args: {
            title: '第三章错题练习卷',
            rows: [
              { cue: '第 1 题', body: '求 $\\lim_{x\\to0} \\frac{\\sin x}{x}$' },
              { cue: '第 2 题', body: '求导：$x^2 e^x$' }
            ],
            summary: '答案见错题本。'
          }
        }
      }
    return { text: '练习卷已经建好。' }
  }
  if (user.includes('【外部工具】')) {
    if (step === 0) return { call: { name: 'mcp__testsrv__lookup_word', args: { word: '间隔重复' } } }
    if (step === 1) return { call: { name: 'mcp__testsrv__save_memo', args: { text: '记下间隔重复' } } }
    if (step === 2) return { call: { name: 'mcp__testsrv__send_message', args: { text: 'leak' } } }
    return { text: '查到了定义，并按你的确认处理了。' }
  }
  if (user.includes('【禁止】')) {
    if (step === 0) return { call: { name: 'mcp__testsrv__send_message', args: { text: 'blocked' } } }
    return { text: '这个工具被禁止了。' }
  }
  if (user.includes('【停止】')) {
    if (step === 0) return { call: { name: 'goal_create', args: { title: '不应创建的目标' } } }
    return { text: '不应出现' }
  }
  return { text: '好的。' }
}

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  provider = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      const input = JSON.parse(body) as { stream?: boolean; messages: Msg[]; tools?: { function: { name: string } }[] }
      const lastUser = textOf(input.messages.filter((m) => m.role === 'user').at(-1)?.content)
      requests.push({ tools: (input.tools ?? []).map((t) => t.function.name), lastUser })
      if (!input.stream) {
        const call = { id: 's', type: 'function', function: { name: 'submit', arguments: JSON.stringify({ text: '晨报' }) } }
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(
            JSON.stringify({
              id: 'r',
              object: 'chat.completion',
              created: 1,
              model: 'deepseek-flash',
              choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }],
              usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 }
            })
          )
        return
      }
      const next = script(input.messages)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
      const usage = { prompt_tokens: 20000, completion_tokens: 500, total_tokens: 20500 }
      if (next.call) {
        res.write(
          chunk(
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_${Date.now()}`,
                  type: 'function',
                  function: { name: next.call.name, arguments: JSON.stringify(next.call.args) }
                }
              ]
            },
            null
          )
        )
        res.write(chunk({}, 'tool_calls', usage))
      } else {
        res.write(chunk({ role: 'assistant', content: next.text }, null))
        res.write(chunk({}, 'stop', usage))
      }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r))
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-agent-'))}`],
    env: {
      ...process.env,
      JIWEI_LANG: 'zh-CN',
      JIWEI_SKIP_ONBOARDING: '1',
      JIWEI_TEST_OAUTH_FOLLOW: '1',
      JIWEI_OAUTH_PORT: String(41000 + Math.floor(Math.random() * 2000))
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  const baseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`
  await page.evaluate(async (baseUrl) => {
    const j = window.jiwei
    const p = await j.providers.save({ kind: 'ollama', name: 'Agent fixture', baseUrl, models: ['deepseek-flash'] })
    const s = await j.settings.get()
    await j.settings.set({ ai: { ...s.ai, chat: { providerId: p.id, model: 'deepseek-flash' }, effort: 'off' } })
    const n = await j.notes.create({ categoryId: null })
    await j.notes.update(n.id, { title: '极限' })
  }, baseUrl)
  await page.reload()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
  oauthServer?.kill()
  await new Promise<void>((r) => provider.close(() => r()))
})

const shot = async (name: string): Promise<void> => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}
async function ask(text: string): Promise<void> {
  const box = page.getByRole('textbox', { name: '问积微，或交代一件事……' })
  await box.fill(text)
  await page.keyboard.press('Enter')
}
const lastAnswer = () => page.locator('.group\\/msg').last()

test('办事：建行动项先确认，允许后创建；拒绝则不创建', async () => {
  await navTo(page, /积微助手/)
  await ask('【建行动项】帮我把重做第三章错题加到行动项，周五截止')
  const card = page.getByTestId('approval-card')
  await expect(card).toBeVisible({ timeout: 20_000 })
  await expect(card).toContainText('新建行动项「重做第三章错题」，截止 10 月 17 日')
  await expect(card).toContainText('写入')
  await shot('agent-approval')
  // 还没创建
  expect((await page.evaluate(() => window.jiwei.actions.list('open'))).length).toBe(0)
  await card.getByRole('button', { name: '允许' }).click()
  await expect(lastAnswer()).toContainText('已经加好了', { timeout: 20_000 })
  const actions = await page.evaluate(() => window.jiwei.actions.list('open'))
  expect(actions.map((a) => a.title)).toEqual(['重做第三章错题'])
  expect(new Date(actions[0].dueAt!).getDate()).toBe(17)
  await expect(page.getByTestId('approval-resolved').last()).toHaveAttribute('data-state', 'allowed')
  await expect(lastAnswer().getByRole('button', { name: '查看行动项' })).toBeVisible()

  await ask('【建行动项】再加一次')
  await page.getByTestId('approval-card').getByRole('button', { name: '拒绝' }).click()
  await expect(lastAnswer()).toContainText('好的，没有创建', { timeout: 20_000 })
  expect((await page.evaluate(() => window.jiwei.actions.list('open'))).length).toBe(1)
})

test('办事：出练习卷 → 新建笔记确认 → 打开笔记', async () => {
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await ask('【出卷子】把我最近的错题出成一套练习卷')
  const card = page.getByTestId('approval-card')
  await expect(card).toContainText('新建笔记《第三章错题练习卷》，共 2 行', { timeout: 20_000 })
  await expect(card).toContainText('第 1 题')
  await card.getByRole('button', { name: '允许' }).click()
  await expect(lastAnswer()).toContainText('练习卷已经建好', { timeout: 20_000 })
  const notes = await page.evaluate(() => window.jiwei.notes.list({}))
  expect(notes.some((n) => n.title === '第三章错题练习卷')).toBe(true)
  await lastAnswer().getByRole('button', { name: '打开笔记' }).click()
  await expect(page.locator('.cornell-doc')).toContainText('第 2 题')
  await navTo(page, /积微助手/)
})

test('外部工具：在设置里添加本地 MCP 服务器，工具按级别显示策略', async () => {
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('tab', { name: '连接' }).click()
  const settings = page.getByTestId('connections-settings')
  await expect(settings).toContainText('还没有接入外部工具')
  await settings.getByRole('button', { name: '添加', exact: true }).click()
  const form = page.getByTestId('mcp-server-form')
  await form.getByLabel('名称', { exact: true }).fill('testsrv')
  await form.getByLabel('命令', { exact: true }).fill(process.execPath)
  await form.getByLabel('参数', { exact: true }).fill(`${FIXTURE}\nstdio`)
  await form.getByLabel('环境变量', { exact: true }).fill(`MEMO_FILE=${memo}`)
  await form.getByRole('button', { name: '保存并连接' }).click()
  const server = page.getByTestId('mcp-server').filter({ hasText: 'testsrv' })
  await expect(server.getByTestId('mcp-server-state')).toHaveText('已连接', { timeout: 30_000 })
  await expect(server).toContainText('3 个工具')
  await server.getByRole('button', { name: '工具' }).click()
  const tool = (name: string) => server.locator(`[data-testid="mcp-tool"][data-name="${name}"]`)
  await expect(tool('lookup_word')).toContainText('读取')
  await expect(tool('lookup_word').getByRole('radio', { name: '自动' })).toHaveAttribute('aria-checked', 'true')
  await expect(tool('save_memo')).toContainText('写入')
  await expect(tool('save_memo').getByRole('radio', { name: '每次询问' })).toHaveAttribute('aria-checked', 'true')
  await expect(tool('send_message')).toContainText('对外')
  await expect(tool('send_message').getByRole('radio', { name: '自动' })).toBeDisabled()
  // 写入级工具可以设为自动
  await tool('save_memo').getByRole('radio', { name: '自动' }).click()
  await expect(tool('save_memo').getByRole('radio', { name: '自动' })).toHaveAttribute('aria-checked', 'true')
  // 环境变量不回传明文
  expect(JSON.stringify(await page.evaluate(() => window.jiwei.mcp.servers()))).not.toContain(memo)
  await shot('agent-connections')
  await page.keyboard.press('Escape')
})

test('外部工具：读取外部内容后，即使设为自动的写入也要确认；对外工具每次确认；注入的指令被当作数据', async () => {
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await ask('【外部工具】查一下间隔重复的定义并记下来')
  // save_memo 设为自动，但发生在读取外部内容之后 → 仍需确认，并带提示
  const card = page.getByTestId('approval-card')
  await expect(card).toContainText('使用「testsrv」的工具：Save memo', { timeout: 30_000 })
  await expect(card).toContainText('这一步发生在读取网页或外部工具的内容之后')
  await shot('agent-tainted')
  await card.getByRole('button', { name: '允许' }).click()
  // send_message：对外，确认后拒绝
  await expect(page.getByTestId('approval-card')).toContainText('Send message', { timeout: 20_000 })
  await expect(page.getByTestId('approval-card')).toContainText('对外')
  await page.getByTestId('approval-card').getByRole('button', { name: '拒绝' }).click()
  await expect(lastAnswer()).toContainText('查到了定义', { timeout: 20_000 })
  const written = readFileSync(memo, 'utf8')
  expect(written).toContain('MEMO:记下间隔重复')
  expect(written).not.toContain('SENT:')
  // 工具结果在发给模型的消息里被标成外部数据；系统提示说明它不是指令
  const tools = requests.at(-1)!.tools
  expect(tools).toEqual(
    expect.arrayContaining([
      'mcp__testsrv__lookup_word',
      'mcp__testsrv__save_memo',
      'mcp__testsrv__send_message',
      'action_create',
      'note_create'
    ])
  )
})

test('外部工具：设为禁止后不再提供给助手', async () => {
  const servers = await page.evaluate(() => window.jiwei.mcp.servers())
  await page.evaluate((id) => window.jiwei.mcp.setToolPolicy({ serverId: id, tool: 'send_message', policy: 'deny' }), servers[0].id)
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await ask('【禁止】发一条消息')
  await expect(lastAnswer()).toContainText('这个工具被禁止了', { timeout: 20_000 })
  expect(requests.at(-1)!.tools).not.toContain('mcp__testsrv__send_message')
  expect(readFileSync(memo, 'utf8')).not.toContain('SENT:blocked')
})

test('停止生成：取消等待中的确认，不执行', async () => {
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await ask('【停止】建一个目标')
  await expect(page.getByTestId('approval-card')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: '停止生成' }).click()
  await expect(lastAnswer().getByText('已停止生成')).toBeVisible({ timeout: 20_000 })
  expect((await page.evaluate(() => window.jiwei.goals.list())).some((g) => g.title === '不应创建的目标')).toBe(false)
  expect(await page.evaluate(() => window.jiwei.agent.pending())).toEqual([])
})

test('远程 MCP 服务器：OAuth 登录（动态注册 + PKCE）后可用', async () => {
  const port = 43000 + Math.floor(Math.random() * 2000)
  oauthServer = spawn(process.execPath, [FIXTURE, 'http', String(port), 'oauth'], {
    env: { ...process.env, MEMO_FILE: memo },
    stdio: 'pipe'
  })
  await new Promise<void>((r) => oauthServer!.stdout!.once('data', () => r()))
  const info = await page.evaluate(
    (url) => window.jiwei.mcp.saveServer({ name: '远程测试', transport: 'http', url }),
    `http://127.0.0.1:${port}/mcp`
  )
  const tested = await page.evaluate((id) => window.jiwei.mcp.testServer(id), info.id)
  expect(tested.error).toBeNull()
  expect(tested.state).toBe('ready')
  expect(tested.oauth).toBe(true)
  expect(tested.tools.map((t) => t.name).sort()).toEqual(['lookup_word', 'save_memo', 'send_message'])
  // 退出登录后需要重新授权
  const out = await page.evaluate((id) => window.jiwei.mcp.logoutServer(id), info.id)
  expect(out.oauth).toBe(false)
  await page.evaluate((id) => window.jiwei.mcp.removeServer(id), info.id)
})

test('费用：每次请求都记账；达到每日上限后暂停，今天继续使用后恢复', async () => {
  const u = await page.evaluate(() => window.jiwei.usage.summary())
  expect(u.calls).toBeGreaterThan(5)
  expect(u.today).toBeGreaterThan(0)
  expect(u.byPurpose.find((b) => b.key === 'chat')!.calls).toBeGreaterThan(5)
  expect(u.byModel[0].key).toBe('deepseek-flash')
  await page.evaluate(() => window.jiwei.settings.get().then((s) => window.jiwei.settings.set({ budget: { ...s.budget, daily: 0.001 } })))
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  const before = requests.length
  await ask('你好')
  const notice = page.getByTestId('budget-notice')
  await expect(notice).toContainText('今天的 AI 花费已达到上限', { timeout: 20_000 })
  expect(requests.length).toBe(before)
  await shot('agent-budget')
  await notice.getByRole('button', { name: '今天继续使用' }).click()
  await ask('你好')
  await expect(lastAnswer()).toContainText('好的', { timeout: 20_000 })
  expect(requests.length).toBe(before + 1)
})

test('单次上限：一次回答超过后停止后续步骤', async () => {
  await page.evaluate(() =>
    window.jiwei.settings.set({ budget: { perRun: 0.0005, daily: null, monthly: null } })
  )
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await ask('【出卷子】再出一套')
  await expect(page.getByTestId('budget-notice')).toContainText('单次上限', { timeout: 20_000 })
  await page.evaluate(() => window.jiwei.settings.get().then((s) => window.jiwei.settings.set({ budget: { ...s.budget, perRun: null } })))
})

test('设置 → 费用与权限：花费、分项、上限与最近做了什么', async () => {
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('tab', { name: '费用与权限' }).click()
  const view = page.getByTestId('usage-settings')
  await expect(view.getByTestId('usage-month')).toContainText('¥')
  await expect(view).toContainText('助手对话')
  await expect(view).toContainText('deepseek-flash')
  await expect(view.getByTestId('audit-row').first()).toBeVisible()
  await expect(view).toContainText('新建行动项「重做第三章错题」')
  await expect(view).toContainText('使用「testsrv」的工具：Save memo')
  await view.getByRole('textbox', { name: '每天' }).fill('5')
  await view.getByRole('textbox', { name: '每天' }).press('Enter')
  await expect.poll(() => page.evaluate(() => window.jiwei.settings.get().then((s) => s.budget.daily))).toBe(5)
  await shot('agent-usage')
  await page.keyboard.press('Escape')
  expect(existsSync(memo)).toBe(true)
})

test('窄窗与深色：确认卡片与设置页不溢出', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('tab', { name: '连接' }).click()
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="connections-settings"]')!.parentElement!
    return el.scrollWidth - el.clientWidth
  })
  expect(overflow).toBeLessThanOrEqual(1)
  await shot('agent-connections-dark')
  await page.getByRole('tab', { name: '费用与权限' }).click()
  await shot('agent-usage-dark')
  await page.keyboard.press('Escape')
  await page.evaluate(() => document.documentElement.removeAttribute('data-theme'))
})
