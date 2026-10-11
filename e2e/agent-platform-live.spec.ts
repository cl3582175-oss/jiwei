import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFile } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'

// v0.7 真实环境验收：真实 DeepSeek 办事、真实 MCP 服务器（官方 server-filesystem）、真实第三方客户端（官方 MCP Inspector）。
// 运行：JIWEI_IMPORT_PROVIDERS_FROM=<应用数据库> npx playwright test e2e/agent-platform-live.spec.ts
// 回答全文另存（SHOTS_DIR/agent-platform-live.json）供人工阅读。
const source = process.env.JIWEI_IMPORT_PROVIDERS_FROM
test.skip(!source, '需要 JIWEI_IMPORT_PROVIDERS_FROM（真实服务商配置）')
test.describe.configure({ mode: 'serial' })
test.setTimeout(400_000)

let app: ElectronApplication, page: Page
const out = process.env.SHOTS_DIR
const record: Record<string, unknown> = {}
const save = (): void => {
  if (!out) return
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'agent-platform-live.json'), JSON.stringify(record, null, 2))
}
const shot = async (name: string): Promise<void> => {
  if (out) await page.screenshot({ path: join(out, `${name}.png`) })
}
const work = mkdtempSync(join(tmpdir(), 'jiwei-live-fs-'))
const PORT = 46000 + Math.floor(Math.random() * 2000)

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-agent-live-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-live-src-'))
  writeFileSync(
    join(dir, '极限与导数.md'),
    [
      '# 极限与导数（考研数学一）',
      '',
      '## 重要极限',
      'sin x / x 在 x→0 时的极限为 1；(1+1/n)^n 在 n→∞ 时的极限为 e。',
      '',
      '## 洛必达法则',
      '使用条件：必须是 0/0 型或 ∞/∞ 型未定式，分子分母在去心邻域内可导，且导数之比的极限存在（或为无穷）。不满足条件时不能使用，例如 (x+sin x)/x。',
      '',
      '## 泰勒公式',
      '带佩亚诺余项的麦克劳林展开：e^x = 1 + x + x²/2 + o(x²)；sin x = x − x³/6 + o(x³)。',
      '',
      '## 导数的几何意义',
      '导数是切线斜率；可导一定连续，连续不一定可导，例如 |x| 在 0 点。'
    ].join('\n')
  )
  writeFileSync(
    join(work, 'plan.md'),
    '# 本周安排\n\n- 下周三（10 月 21 日）考概率论第二章，需要提前做完课后习题。\n- 周六交线性代数作业。\n'
  )
  await page.evaluate(
    async (path) => {
      await window.jiwei.sources.importPaths([path])
    },
    join(dir, '极限与导数.md')
  )
  await expect.poll(() => page.evaluate(() => window.jiwei.providers.list().then((p) => p.some((x) => x.hasKey)))).toBe(true)
})
test.afterAll(async () => {
  save()
  await app?.close()
})

async function ask(text: string): Promise<void> {
  await page.getByRole('textbox', { name: '问积微，或交代一件事……' }).fill(text)
  await page.keyboard.press('Enter')
}
async function lastMessage(): Promise<{
  content: string
  steps: { tool: string; label: string; status: string }[]
  status: string
  usage: unknown
}> {
  const convs = await page.evaluate(() => window.jiwei.chat.conversations())
  const msgs = await page.evaluate((id) => window.jiwei.chat.messages(id), convs[0].id)
  return msgs.at(-1)! as never
}
/** 回答过程中出现确认卡片就允许，直到回答结束 */
async function allowUntilDone(maxApprovals = 4): Promise<string[]> {
  const titles: string[] = []
  for (let i = 0; i < 60 * 6; i++) {
    const card = page.getByTestId('approval-card')
    if (await card.isVisible().catch(() => false)) {
      titles.push((await card.innerText()).replace(/\s+/g, ' '))
      if (titles.length > maxApprovals) throw new Error('too many approvals')
      await card.getByRole('button', { name: '允许' }).click()
      await page.waitForTimeout(500)
      continue
    }
    const m = await lastMessage().catch(() => null)
    if (m && m.status !== 'streaming') return titles
    await page.waitForTimeout(500)
  }
  throw new Error('answer did not finish')
}

test('真实 DeepSeek：交代建行动项 → 确认卡片写清楚 → 创建，截止日是周五', async () => {
  await navTo(page, /积微助手/)
  await page.getByRole('radio', { name: '关闭' }).click()
  await ask('帮我把“重做第三章错题”加到行动项里，这周五截止。')
  await expect(page.getByTestId('approval-card')).toBeVisible({ timeout: 120_000 })
  const card = (await page.getByTestId('approval-card').innerText()).replace(/\s+/g, ' ')
  await shot('live-approval')
  await page.getByTestId('approval-card').getByRole('button', { name: '允许' }).click()
  await expect.poll(async () => (await lastMessage()).status, { timeout: 120_000 }).toBe('done')
  const m = await lastMessage()
  record.action = { card, answer: m.content, steps: m.steps.map((s) => `${s.tool}: ${s.label} (${s.status})`) }
  save()
  expect(card).toContain('重做第三章错题')
  const actions = await page.evaluate(() => window.jiwei.actions.list('open'))
  expect(actions.some((a) => a.title.includes('第三章错题'))).toBe(true)
  const due = new Date(actions.find((a) => a.title.includes('第三章错题'))!.dueAt!)
  expect(due.getDay()).toBe(5)
})

test('真实 DeepSeek：按资料出一套练习卷，建成新笔记', async () => {
  await navTo(page, /积微助手/)
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await ask(
    '根据我资料库里《极限与导数》这份资料，出一套 4 道题的练习卷，建成一篇新笔记：线索栏写题号和考点，笔记栏写题目，答案放在总结里。'
  )
  const approvals = await allowUntilDone()
  const m = await lastMessage()
  record.paper = { approvals, answer: m.content, steps: m.steps.map((s) => `${s.tool}: ${s.label} (${s.status})`) }
  save()
  expect(approvals.some((a) => a.includes('新建笔记'))).toBe(true)
  const notes = await page.evaluate(() => window.jiwei.notes.list({}))
  expect(notes.length).toBe(1)
  record.paperTitle = notes[0].title
  await page.getByRole('button', { name: '打开笔记' }).last().click()
  await expect(page.locator('.cornell-doc')).toBeVisible()
  const text = await page.locator('.cornell-doc').innerText()
  record.paperNote = text
  save()
  expect(text).toMatch(/洛必达|泰勒|极限|导数/)
  await shot('live-paper-note')
  await navTo(page, /积微助手/)
})

test('真实 MCP 服务器（官方 server-filesystem）：读文件自动，据此建行动项需确认；写文件每次确认', async () => {
  const info = await page.evaluate(
    (work) =>
      window.jiwei.mcp.saveServer({
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem@2026.8.31', work]
      }),
    work
  )
  const tested = await page.evaluate((id) => window.jiwei.mcp.testServer(id), info.id)
  record.fsServer = { state: tested.state, error: tested.error, tools: tested.tools.map((t) => `${t.name}:${t.level}:${t.policy}`) }
  save()
  expect(tested.state).toBe('ready')
  expect(tested.tools.find((t) => t.name === 'read_text_file')?.policy).toBe('auto')
  expect(tested.tools.find((t) => t.name === 'write_file')?.policy).toBe('ask')

  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await ask(`读一下 ${join(work, 'plan.md')}，把里面的考试安排建成一个行动项，截止日用考试那天。`)
  const approvals = await allowUntilDone()
  let m = await lastMessage()
  record.fsAction = { approvals, answer: m.content, steps: m.steps.map((s) => `${s.tool}: ${s.label} (${s.status})`) }
  save()
  expect(m.steps.some((s) => s.tool.startsWith('mcp__filesystem__') && s.status === 'done')).toBe(true)
  // 读取外部内容之后的写入：卡片上有提示
  expect(approvals.some((a) => a.includes('新建行动项') && a.includes('读取网页或外部工具的内容之后'))).toBe(true)
  const actions = await page.evaluate(() => window.jiwei.actions.list('open'))
  const exam = actions.find((a) => a.title.includes('概率论'))
  expect(exam).toBeTruthy()
  expect(new Date(exam!.dueAt!).getDate()).toBe(21)

  await ask(`在 ${work} 目录里写一个 summary.md，内容是一句话：本周重点是概率论第二章。`)
  const writes = await allowUntilDone()
  m = await lastMessage()
  record.fsWrite = { approvals: writes, answer: m.content }
  save()
  expect(writes.some((a) => a.includes('filesystem'))).toBe(true)
  expect(existsSync(join(work, 'summary.md'))).toBe(true)
  expect(readFileSync(join(work, 'summary.md'), 'utf8')).toContain('概率论')
  await shot('live-fs')
})

test('记账：每次真实请求都记了一笔，金额与回答显示的一致', async () => {
  const u = await page.evaluate(() => window.jiwei.usage.summary())
  const convs = await page.evaluate(() => window.jiwei.chat.conversations())
  let shown = 0
  for (const c of convs) for (const m of await page.evaluate((id) => window.jiwei.chat.messages(id), c.id)) shown += m.usage?.cost ?? 0
  const chat = u.byPurpose.filter((b) => b.key === 'chat').reduce((s, b) => s + b.cost, 0)
  record.usage = { month: u.month, chat, shown, byPurpose: u.byPurpose, byModel: u.byModel }
  save()
  expect(u.calls).toBeGreaterThan(4)
  expect(chat).toBeGreaterThan(0)
  // 回答下方显示的是整段回答的合计，与逐次记账之和应一致（允许 5% 的浮点与闲时折扣边界误差）
  expect(Math.abs(chat - shown) / shown).toBeLessThan(0.05)
})

test('真实第三方客户端：官方 MCP Inspector 经 stdio 桥接与 HTTP 访问积微', async () => {
  await page.evaluate((port) => window.jiwei.settings.set({ mcpServe: { enabled: true, port } }), PORT)
  await expect.poll(() => page.evaluate(() => window.jiwei.mcp.serveStatus().then((s) => s.listening))).toBe(true)
  const secret = await page.evaluate(() => window.jiwei.mcp.createClient({ name: 'MCP Inspector', access: 'read' }))
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-inspector-'))
  // 原样使用设置页给出的 Claude Desktop 配置片段
  writeFileSync(join(dir, 'mcp.json'), secret.configs.find((c) => c.id === 'claude-desktop')!.text)
  const inspector = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = execFile(
        'npx',
        ['-y', '@modelcontextprotocol/inspector@2.8.0', '--cli', ...args],
        { cwd: dir, timeout: 240_000 },
        (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stdout}\n${stderr}`)) : resolve(stdout))
      )
      child.stdin?.end()
    })
  const stdio = await inspector([
    '--config',
    join(dir, 'mcp.json'),
    '--server',
    'jiwei',
    '--method',
    'tools/call',
    '--tool-name',
    'search_knowledge',
    '--tool-arg',
    'query=洛必达法则'
  ])
  record.inspectorStdio = stdio.slice(0, 3000)
  save()
  expect(stdio).toContain('洛必达')
  expect(stdio).toContain('极限与导数')
  const http = secret.configs.find((c) => c.id === 'http')!
  const { url, headers } = JSON.parse(http.text) as { url: string; headers: { Authorization: string } }
  const listed = await inspector([
    '--server-url',
    url,
    '--transport',
    'http',
    '--header',
    `Authorization: ${headers.Authorization}`,
    '--method',
    'tools/list'
  ])
  record.inspectorHttp = listed.slice(0, 1500)
  save()
  expect(listed).toContain('propose_note_edit')
  const audit = await page.evaluate(() => window.jiwei.agent.audit({ caller: 'mcp:MCP Inspector' }))
  record.inspectorAudit = audit.map((a) => `${a.tool}: ${a.summary} (${a.status})`)
  save()
  expect(audit.some((a) => a.tool === 'search_knowledge' && a.status === 'ok')).toBe(true)
})
