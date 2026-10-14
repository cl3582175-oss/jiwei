import { attachmentModel, textOf } from './fixtures/attachment-model'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { samples } from '../src/shared/ui/__tests__/fixtures'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { xlsxFixture, pptxFixture } from '../src/main/services/parsers/__tests__/fixtures'
import { navTo } from './fixtures/nav'

test.describe.configure({ mode: 'serial' })
let model: Awaited<ReturnType<typeof attachmentModel>>,
  providerId = ''
let app: ElectronApplication, page: Page
const userDataDir = mkdtempSync(join(tmpdir(), 'jiwei-chat-attachments-'))
test.beforeAll(async () => {
  model = await attachmentModel()
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      JIWEI_SKIP_ONBOARDING: '1',
      JIWEI_LANG: 'zh-CN',
      JIWEI_IMPORT_PROVIDERS_FROM: '',
      JIWEI_VOICE_MODELS_APPDATA: userDataDir,
      JIWEI_TEST_NETWORK: '1',
      JIWEI_MEMORY_DELAY_MS: '3600000'
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  providerId = await page.evaluate(async (baseUrl) => {
    const p = await window.jiwei.providers.save({
      kind: 'openai',
      name: '附件受控服务',
      baseUrl,
      apiKey: 'controlled-test-key',
      models: ['attachments-controlled'],
      modelCaps: { 'attachments-controlled': { vision: true, tools: true, tier: 'strong' } }
    })
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      ai: { ...s.ai, chat: { providerId: p.id, model: 'attachments-controlled' }, effort: 'off' },
      discover: { ...s.discover, useSearch: false }
    })
    return p.id
  }, model.url)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
})
test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => model?.server.close(() => resolve()))
})

test('P2 测试启动前已隔离模型缓存，不读取真实模型目录', async () => {
  expect(await app.evaluate(({ app }) => app.getPath('appData'))).toBe(process.env.JIWEI_TEST_MODEL_CACHE_ROOT)
  expect((await page.evaluate(() => window.jiwei.embedding.status())).state).not.toBe('ready')
})

test('P2 资料库导入 xlsx/csv/pptx/代码，真实作业解析并能打开阅读', async () => {
  const paths = [
    join(userDataDir, 'sales.xlsx'),
    join(userDataDir, 'sales.csv'),
    join(userDataDir, 'slides.pptx'),
    join(userDataDir, 'sample.ts')
  ]
  writeFileSync(paths[0], await xlsxFixture())
  writeFileSync(paths[1], 'name,value\nA,12\nB,18')
  writeFileSync(paths[2], await pptxFixture())
  writeFileSync(paths[3], '    const answer = 42')
  const result = await page.evaluate((files) => window.jiwei.sources.importPaths(files), paths)
  expect(result.imported).toHaveLength(4)
  for (const source of result.imported)
    await expect.poll(async () => (await page.evaluate((id) => window.jiwei.segments.list(id), source.id)).length).toBeGreaterThan(0)
  const texts = await page.evaluate(
    async (ids) => Promise.all(ids.map(async (id) => (await window.jiwei.segments.list(id)).map((s) => s.text).join('\n'))),
    result.imported.map((s) => s.id)
  )
  expect(texts[0]).toContain('## 销售')
  expect(texts[1]).toContain('| A | 12 |')
  expect(texts[2]).toContain('讲者备注：备注 2')
  expect(texts[3]).toContain('```typescript\n    const answer = 42')
  await navTo(page, /资料库/)
  await expect(page.getByText('sales', { exact: true }).first()).toBeVisible()
})

async function add(name: string, data: Uint8Array | string, conversationId?: string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const path = join(userDataDir, name)
  writeFileSync(path, bytes)
  const [a] = await page.evaluate(({ path, conversationId }) => window.jiwei.attachments.add({ paths: [path], conversationId }), {
    path,
    conversationId
  })
  expect(a.status, a.error ?? '').not.toBe('failed')
  await expect.poll(async () => (await page.evaluate((id) => window.jiwei.attachments.status([id]), a.sourceId))[0]?.status).toBe('ready')
  return a.sourceId
}
async function send(text: string, attachments: string[] = [], conversationId: string | null = null, all = false) {
  const result = await page.evaluate(
    ({ text, attachments, conversationId, providerId, all }) =>
      window.jiwei.chat.send({
        text,
        attachments,
        conversationId,
        providerId,
        model: 'attachments-controlled',
        effort: 'off',
        scope: all ? { type: 'all' } : { type: 'none' },
        web: 'off'
      }),
    { text, attachments, conversationId, providerId, all }
  )
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.jiwei.chat.messages(id), result.conversation.id)).find(
          (m) => m.id === result.assistantMessageId
        )?.status
    )
    .not.toBe('streaming')
  const messages = await page.evaluate((id) => window.jiwei.chat.messages(id), result.conversation.id)
  expect(
    messages.find((m) => m.id === result.assistantMessageId)?.status,
    messages.find((m) => m.id === result.assistantMessageId)?.error ?? ''
  ).toBe('done')
  return { ...result, messages }
}
const lastRequestText = (): string =>
  model.requests
    .at(-1)!
    .messages.map((m) => textOf(m.content))
    .join('\n')
async function showConversation(title: string): Promise<void> {
  await navTo(page, /AI 对话/)
  await page.getByText(title, { exact: true }).first().click()
}

// §3.5：所有入口均使用实际服务/IPC/HTTP；记录整个受控模型服务器的请求。
test('P3 隔离：其他对话、工具、推荐、今日、发现、记忆、MCP、图谱和搜索无标记；归档后出现', async () => {
  const marker = 'ZZ-ATTACH-MARKER-7f3a'
  const base = await send('隔离准备')
  const baseSystem = textOf(model.requests.at(-1)!.messages.find((m) => m.role === 'system')!.content)
  const id = await add('isolation.txt', `附件隔离试验正文\n${marker}`)
  model.setAnswer(marker)
  const owned = await send('读取本对话隔离资料', [id], base.conversation.id)
  const ownRequest = model.requests.at(-1)!
  expect(JSON.stringify(ownRequest)).toContain(marker)
  expect(
    textOf(ownRequest.messages.find((m) => m.role === 'system')!.content)
      .split('【本对话的附件】')[0]
      .trimEnd()
  ).toBe(baseSystem)
  const start = model.requests.length
  model.setAnswer('受控公共回答')
  const other = await send('在全部知识库查找附件隔离试验', [], null, true)
  model.tool('knowledge_search', { query: '附件隔离试验' })
  await send('用知识检索工具查找隔离试验', [], other.conversation.id, true)
  expect(model.requests.slice(start).some((r) => r.messages.some((m) => m.role === 'tool'))).toBe(true)
  const n = await page.evaluate(() => window.jiwei.notes.create({ title: '普通测试笔记' }))
  await page.evaluate(({ noteId, sourceId }) => window.jiwei.connections.relate(noteId, 'source', sourceId), { noteId: n.id, sourceId: id })
  const uiResults: unknown[] = [await page.evaluate((noteId) => window.jiwei.connections.get(noteId), n.id)]
  model.tool('today_overview', {})
  await send('请通过工具查看今日概览', [], null, true)
  uiResults.push(await page.evaluate(() => window.jiwei.today.summary()))
  await page.evaluate(async () => {
    await window.jiwei.memory.setSettings({ autoLearn: true })
  })
  const memoryStart = model.requests.length
  await page.evaluate((id) => window.jiwei.memory.learnNow(id), owned.conversation.id)
  expect(model.requests).toHaveLength(memoryStart)
  await page.evaluate((id) => window.jiwei.memory.learnNow(id), other.conversation.id)
  expect(model.requests.length).toBeGreaterThan(memoryStart)
  const goal = await page.evaluate(() => window.jiwei.goals.save({ title: '受控学习方向', kind: 'exam', weeklyMinutes: 30 }))
  await page.evaluate(({ url, goalId }) => window.jiwei.discover.feedSave({ kind: 'rss', url, title: '受控订阅', enabled: true, goalId }), {
    url: model.url.replace('/v1', '/feed'),
    goalId: goal.id
  })
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.discover.items(true))).length).toBeGreaterThan(0)
  const discoverStart = model.requests.length
  const jobId = await page.evaluate(() => window.jiwei.discover.runNow())
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.jobs.list())).find((j) => j.id === jobId)?.status).toBe('done')
  expect(model.requests.length).toBeGreaterThan(discoverStart)
  uiResults.push(await page.evaluate(() => window.jiwei.discover.items(true)))
  const port = 43000 + Math.floor(Math.random() * 1000)
  await page.evaluate((port) => window.jiwei.settings.set({ mcpServe: { enabled: true, port } }), port)
  await expect.poll(() => page.evaluate(() => window.jiwei.mcp.serveStatus().then((s) => s.listening))).toBe(true)
  const secret = await page.evaluate(() => window.jiwei.mcp.createClient({ name: '附件隔离测试', access: 'read' }))
  const client = new Client({ name: 'attachments-test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${secret.token}` } }
    })
  )
  try {
    uiResults.push(await client.callTool({ name: 'search_knowledge', arguments: { query: '附件隔离试验' } }))
  } finally {
    await client.close()
  }
  uiResults.push(await page.evaluate(() => window.jiwei.graph.data()))
  uiResults.push(await page.evaluate(() => window.jiwei.sources.list({ search: '隔离' })))
  uiResults.push(await page.evaluate(() => window.jiwei.segments.search('附件隔离试验')))
  expect(JSON.stringify(uiResults)).not.toContain(marker)
  expect(JSON.stringify(model.requests.slice(start))).not.toContain(marker)
  expect(JSON.stringify(await page.evaluate(() => window.jiwei.graph.data()))).not.toContain(id)
  await page.evaluate((id) => window.jiwei.attachments.archive([id], null), id)
  await send('在全部知识库查找附件隔离试验', [], null, true)
  expect(lastRequestText()).toContain(marker)
  await page.evaluate((id) => window.jiwei.sources.trash(id), id)
})

let multiConversation = '',
  pdfId = '',
  txtId = ''
test('P3 短txt全文与60页长PDF：原文封装、处理就绪、附件节和范围none', async () => {
  txtId = await add('short.txt', 'SHORT-FULL-CONTENT: 所有短文细节都要进入外部数据块。')
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 60; i++) {
    const p = pdf.addPage([595, 842])
    p.drawText(`PAGE_${i}_ONLY`, { x: 50, y: 780, size: 12, font })
    for (let line = 0; line < 12; line++)
      p.drawText('Long document evidence with details for source reading and citation.', { x: 50, y: 750 - line * 18, size: 10, font })
    if (i === 60) p.drawText('PDF_FINAL_TAIL_ONLY', { x: 50, y: 480, size: 10, font })
  }
  pdfId = await add('long.pdf', await pdf.save())
  const result = await send('短文与长文总结要点', [txtId, pdfId])
  multiConversation = result.conversation.id
  const request = model.requests.at(-1)!,
    joined = request.messages.map((m) => textOf(m.content)).join('\n')
  expect(joined).toContain('<external-data source="attachment:short.txt">')
  expect(joined).toContain('SHORT-FULL-CONTENT')
  expect(joined).not.toContain('PDF_FINAL_TAIL_ONLY')
  expect(joined).toContain('【本对话的附件】')
  expect(joined).toContain('long.pdf')
  expect(request.tools?.some((t) => t.function.name === 'source_read')).toBe(true)
  expect(request.tools?.some((t) => t.function.name === 'source_outline')).toBe(true)
  expect(request.tools?.some((t) => t.function.name === 'source_digest')).toBe(true)
})

test('P3 多轮source_read读取第3页，第三轮不重复短txt全文', async () => {
  const third = (await page.evaluate((id) => window.jiwei.segments.list(id), pdfId)).find((s) => s.locator.value === 'page=3')!
  model.tool('source_read', { sourceId: pdfId, from: third.ordinal, count: 1 })
  await send('第 3 页讲了什么', [], multiConversation)
  expect(lastRequestText()).toContain('PAGE_3_ONLY')
  await send('另外一件不相关的事情', [], multiConversation)
  expect(lastRequestText()).not.toContain('SHORT-FULL-CONTENT')
})

test('P3 图片附件在首次请求中包含image部分，以后不发图', async () => {
  const id = await add(
    'photo.png',
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
  )
  const result = await send('识别图片', [id])
  expect(JSON.stringify(model.requests.at(-1))).toContain('image_url')
  await send('继续这个话题', [], result.conversation.id)
  expect(JSON.stringify(model.requests.at(-1))).not.toContain('image_url')
})

test('P3 表格请求包含Markdown表格，回答chart组件真实渲染', async () => {
  const id = await add('table-attachment.xlsx', await xlsxFixture())
  model.setAnswer('```jiwei-ui\n' + JSON.stringify({ ...samples.chart, title: '附件图表' }) + '\n```')
  await send('将表格画成图', [id])
  expect(lastRequestText()).toContain('## 销售')
  expect(lastRequestText()).toContain('| 项目 | 数量 | 有效 | 合计 |')
  await showConversation('将表格画成图')
  await expect(page.locator('[data-ui-type="chart"]')).toBeVisible()
  model.setAnswer('受控回答')
})

test('P3 pptx第二页引用跳转真实阅读器第2页', async () => {
  const id = await add('presentation-attachment.pptx', await pptxFixture())
  model.setAnswer('第二页的摘要 [2]')
  const result = await send('演示第二页引用', [id])
  expect(result.messages.at(-1)?.citations.some((c) => c.locator === 'page=2')).toBe(true)
  await showConversation('演示第二页引用')
  await page
    .getByRole('button', { name: /^\[2\]/ })
    .first()
    .click()
  await expect(page.locator('[data-page="2"].is-flash')).toBeVisible()
  model.setAnswer('受控回答')
})
