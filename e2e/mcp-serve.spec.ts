import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'fs'
import { request } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// v0.7：积微作为 MCP 服务端。用官方 SDK 客户端经 HTTP 与 stdio 桥接连接，核对权限三级、隐私、提案与审计。

let app: ElectronApplication, page: Page
const PORT = 40000 + Math.floor(Math.random() * 9000)
const textOf = (r: unknown): string => ((r as { content: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n')

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-mcp-serve-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-mcp-src-'))
  writeFileSync(join(dir, '遗忘曲线.md'), '# 艾宾浩斯遗忘曲线\n\n学习后一天遗忘约 66%。间隔重复在快要遗忘时复习，记忆保持最久。')
  writeFileSync(join(dir, '私人日记.md'), '# 私人日记\n\n间隔重复 这份是秘密内容 SECRET-DIARY，不能给 AI。')
  await page.evaluate(
    async ({ dir, port }) => {
      const j = window.jiwei
      await j.sources.importPaths([`${dir}/遗忘曲线.md`, `${dir}/私人日记.md`])
      const list = await j.sources.list({})
      const diary = list.find((s) => s.title.includes('私人日记'))!
      await j.sources.update(diary.id, { aiExcluded: true })
      const n = await j.notes.create({ categoryId: null })
      await j.notes.update(n.id, { title: '复习方法' })
      const hidden = await j.notes.create({ categoryId: null })
      await j.notes.update(hidden.id, { title: '不给 AI 的笔记', aiExcluded: true })
      await j.settings.set({ mcpServe: { enabled: true, port } })
    },
    { dir, port: PORT }
  )
  await expect.poll(() => page.evaluate(() => window.jiwei.mcp.serveStatus().then((s) => s.listening))).toBe(true)
})
test.afterAll(async () => {
  await app?.close()
})

async function httpClient(token: string): Promise<Client> {
  const c = new Client({ name: 'e2e', version: '1' })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  )
  return c
}

let token = ''
let clientId = ''

test('只读客户端：工具齐全，检索不含“不给 AI”的资料，写入被拒', async () => {
  const secret = await page.evaluate(() => window.jiwei.mcp.createClient({ name: 'Claude Desktop', access: 'read' }))
  token = secret.token
  clientId = secret.client.id
  expect(token).toMatch(/^jw_/)
  expect(secret.configs.map((c) => c.id)).toEqual(['claude-desktop', 'cursor', 'claude-code', 'http'])
  expect(secret.configs[0].text).toContain('ELECTRON_RUN_AS_NODE')
  // 库里不存明文
  expect(JSON.stringify(await page.evaluate(() => window.jiwei.mcp.clients()))).not.toContain(token)

  const c = await httpClient(token)
  const tools = (await c.listTools()).tools.map((t) => t.name).sort()
  expect(tools).toEqual([
    'add_source',
    'add_to_inbox',
    'get_due_reviews',
    'get_mastery',
    'list_notes',
    'propose_note_edit',
    'read_note',
    'read_source',
    'search_knowledge'
  ])
  // 资料导入后在后台分段，等它能被检索到
  let found = ''
  await expect
    .poll(async () => (found = textOf(await c.callTool({ name: 'search_knowledge', arguments: { query: '间隔重复' } }))), {
      timeout: 30_000
    })
    .toContain('遗忘曲线')
  expect(found).not.toContain('SECRET-DIARY')
  const notes = textOf(await c.callTool({ name: 'list_notes', arguments: {} }))
  expect(notes).toContain('复习方法')
  expect(notes).not.toContain('不给 AI 的笔记')
  const denied = await c.callTool({ name: 'add_to_inbox', arguments: { text: '来自 Claude 的想法' } })
  expect(denied.isError).toBe(true)
  expect(textOf(denied)).toContain('read-only')
  const res = await c.listResources()
  expect(res.resources.some((r) => r.name === '复习方法')).toBe(true)
  expect(res.resources.some((r) => r.name === '不给 AI 的笔记')).toBe(false)
  const prompts = await c.listPrompts()
  expect(prompts.prompts.length).toBeGreaterThan(3)
  await c.close()
})

test('提升为“可提议修改”：加收件箱、提案在笔记中等待确认', async () => {
  await page.evaluate((id) => window.jiwei.mcp.updateClient(id, { access: 'propose' }), clientId)
  const c = await httpClient(token)
  const added = await c.callTool({ name: 'add_to_inbox', arguments: { text: '来自 Claude 的想法：用费曼法检验理解' } })
  expect(added.isError).toBeFalsy()
  const inbox = await page.evaluate(() => window.jiwei.inbox.list())
  expect(inbox.some((i) => i.text.includes('来自 Claude 的想法'))).toBe(true)
  const noteId = await page.evaluate(async () => (await window.jiwei.notes.list({})).find((n) => n.title === '复习方法')!.id)
  const proposed = await c.callTool({
    name: 'propose_note_edit',
    arguments: { noteId, title: '补充间隔重复的要点', rows: [{ cue: '什么时候复习最好？', body: '在**快要遗忘**的时候。' }] }
  })
  expect(textOf(proposed)).toContain('not applied yet')
  const proposals = await page.evaluate((id) => window.jiwei.proposals.list(id), noteId)
  expect(proposals[0].title).toBe('补充间隔重复的要点')
  expect(proposals[0].model).toBe('MCP · Claude Desktop')
  // 读“不给 AI”的笔记：找不到
  const hiddenId = await page.evaluate(async () => (await window.jiwei.notes.list({})).find((n) => n.title === '不给 AI 的笔记')!.id)
  const hidden = await c.callTool({ name: 'read_note', arguments: { noteId: hiddenId } })
  expect(hidden.isError).toBe(true)
  await c.close()
})

test('错误令牌、外部 Host 被拒；停用客户端后立即失效', async () => {
  await expect(httpClient('jw_wrong')).rejects.toThrow()
  const status = await new Promise<number>((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: '/mcp',
        method: 'POST',
        headers: { Host: 'evil.example:80', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
      },
      (res) => resolve(res.statusCode ?? 0)
    )
    req.end('{}')
  })
  expect(status).toBe(403)
  await page.evaluate((id) => window.jiwei.mcp.updateClient(id, { enabled: false }), clientId)
  await expect(httpClient(token)).rejects.toThrow()
  await page.evaluate((id) => window.jiwei.mcp.updateClient(id, { enabled: true }), clientId)
})

test('stdio 桥接：用积微自带的 Node 启动桥接脚本，经本机套接字连接', async () => {
  const secret = await page.evaluate(() => window.jiwei.mcp.createClient({ name: 'Cursor', access: 'read' }))
  const cfg = JSON.parse(secret.configs.find((c) => c.id === 'claude-desktop')!.text).mcpServers.jiwei as {
    command: string
    args: string[]
    env: Record<string, string>
  }
  const c = new Client({ name: 'e2e-stdio', version: '1' })
  const tr = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    env: { ...cfg.env, PATH: process.env.PATH ?? '' },
    stderr: 'pipe'
  })
  let err = ''
  tr.stderr?.on('data', (d: Buffer) => (err += d.toString()))
  await c.connect(tr).catch((e) => {
    throw new Error(`${e}\n${err}\n${JSON.stringify(cfg)}`)
  })
  const found = textOf(await c.callTool({ name: 'search_knowledge', arguments: { query: '遗忘曲线' } }))
  expect(found).toContain('遗忘曲线')
  const due = textOf(await c.callTool({ name: 'get_due_reviews', arguments: {} }))
  expect(due).toContain('Due now')
  await c.close()
  // 桥接脚本：令牌错误时给出明确提示
  const bad = new Client({ name: 'bad', version: '1' })
  await expect(
    bad.connect(
      new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: { ...cfg.env, JIWEI_MCP_TOKEN: 'jw_bad', PATH: process.env.PATH ?? '' }
      })
    )
  ).rejects.toThrow()
})

test('审计日志：记录了每次调用和被拒的写入', async () => {
  const entries = await page.evaluate(() => window.jiwei.agent.audit({}))
  const mine = entries.filter((e) => e.caller === 'mcp:Claude Desktop')
  expect(mine.some((e) => e.tool === 'search_knowledge' && e.status === 'ok')).toBe(true)
  expect(mine.some((e) => e.tool === 'add_to_inbox' && e.status === 'denied')).toBe(true)
  expect(mine.some((e) => e.tool === 'propose_note_edit' && e.status === 'ok')).toBe(true)
  expect(entries.some((e) => e.caller === 'mcp:Cursor')).toBe(true)
  const callers = await page.evaluate(() => window.jiwei.agent.auditCallers())
  expect(callers).toEqual(expect.arrayContaining(['mcp:Claude Desktop', 'mcp:Cursor']))
})

test('关闭服务：HTTP 与套接字都停止', async () => {
  await page.evaluate((port) => window.jiwei.settings.set({ mcpServe: { enabled: false, port } }), PORT)
  await expect.poll(() => page.evaluate(() => window.jiwei.mcp.serveStatus().then((s) => s.listening))).toBe(false)
  await expect(httpClient(token)).rejects.toThrow()
})
