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
  page.on('pageerror', (error) => console.error('ATTACHMENT_PAGE_ERROR', error.message))
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
  await page.reload()
  await page.waitForSelector('nav')
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

async function newChat(): Promise<void> {
  await navTo(page, /AI 对话/)
  await page.getByRole('button', { name: '新对话', exact: true }).first().click()
}
async function pickPaths(paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths })
  }, paths)
  await page.getByRole('button', { name: '添加附件', exact: true }).last().click()
}
test('P4 按钮添加附件，空文字建议，首次云提示与消息卡', async () => {
  await newChat()
  const path = join(userDataDir, 'ui-slides.pptx')
  writeFileSync(path, await pptxFixture(4))
  await pickPaths([path])
  const chip = page.getByTestId('attachment-chip').filter({ hasText: 'ui-slides.pptx' }).first()
  await expect(chip).toHaveAttribute('data-status', 'ready')
  await expect(page.getByText('逐页概括', { exact: true })).toBeVisible()
  await expect(page.getByTestId('attachment-cloud-notice')).toBeVisible()
  await page.getByRole('button', { name: '知道了', exact: true }).click()
  await expect(page.getByTestId('attachment-cloud-notice')).toHaveCount(0)
  await page.getByRole('button', { name: '逐页概括', exact: true }).click()
  await expect(page.getByTestId('message-attachments')).toBeVisible()
  await expect(page.getByRole('button', { name: '本对话附件 1', exact: true })).toBeVisible()
})

test('P4 拖放覆盖层、无路径粘贴截图与附件移除', async () => {
  await newChat()
  const input = page.locator('textarea').last()
  const transfer = await page.evaluateHandle(() => {
    const d = new DataTransfer()
    d.items.add(new File(['DROP-FILE-CONTENT'], 'ui-drop.txt', { type: 'text/plain' }))
    return d
  })
  await input.dispatchEvent('dragenter', { dataTransfer: transfer })
  await expect(page.getByTestId('attachment-drop-overlay')).toBeVisible()
  await input.dispatchEvent('drop', { dataTransfer: transfer })
  await expect(page.getByTestId('attachment-drop-overlay')).toHaveCount(0)
  const drop = page.getByTestId('attachment-chip').filter({ hasText: 'ui-drop.txt' })
  await expect(drop).toHaveAttribute('data-status', 'ready')
  await drop.getByRole('button', { name: '移除附件 ui-drop.txt', exact: true }).click()
  await expect(drop).toHaveCount(0)
  const pasted = await page.evaluateHandle(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#35a799'
    ctx.fillRect(0, 0, 8, 8)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
    const d = new DataTransfer()
    d.items.add(new File([blob], 'paste.png', { type: 'image/png' }))
    return d
  })
  await input.evaluate(
    (el, data) => el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })),
    pasted
  )
  const chip = page.getByTestId('attachment-chip').filter({ hasText: 'paste.png' }).first()
  await expect(chip).toHaveAttribute('data-status', 'ready')
  await expect(chip.locator('img')).toBeVisible()
  model.setAnswer('图片附件答复')
  await input.fill('识别截图')
  await page.getByRole('button', { name: '发送', exact: true }).last().click()
  await expect(page.getByTestId('message-attachments')).toBeVisible()
  await expect.poll(() => JSON.stringify(model.requests.at(-1))).toContain('image_url')
})

test('P4 标题栏移出后下一轮不送附件，附件空间仍保留', async () => {
  await newChat()
  const path = join(userDataDir, 'ui-remove.txt')
  writeFileSync(path, 'REMOVE-PRIVATE-ATTACHMENT-MARKER')
  await pickPaths([path])
  await expect(page.getByTestId('attachment-chip').first()).toHaveAttribute('data-status', 'ready')
  model.setAnswer('REMOVE-PRIVATE-ATTACHMENT-MARKER')
  await page.locator('textarea').last().fill('读取资料')
  await page.getByRole('button', { name: '发送', exact: true }).last().click()
  await expect(page.getByText('REMOVE-PRIVATE-ATTACHMENT-MARKER', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '本对话附件 1', exact: true }).click()
  await page.getByTestId('conversation-attachments').getByRole('button', { name: '移出本对话', exact: true }).click()
  await page.keyboard.press('Escape')
  model.setAnswer('继续答复')
  const before = model.requests.length
  await page.locator('textarea').last().fill('继续')
  await page.getByRole('button', { name: '发送', exact: true }).last().click()
  await expect.poll(() => model.requests.length).toBeGreaterThan(before)
  expect(lastRequestText()).not.toContain('REMOVE-PRIVATE-ATTACHMENT-MARKER')
  expect((await page.evaluate(() => window.jiwei.attachments.list({ state: 'unarchived' }))).some((a) => a.name === 'ui-remove.txt')).toBe(
    true
  )
})

test('P4 @引用库内资料合并范围，不给AI的资料拦截；也支持笔记', async () => {
  const paths = [join(userDataDir, 'mention-allowed.txt'), join(userDataDir, 'mention-private.txt')]
  paths.forEach((path, i) => writeFileSync(path, i ? 'PRIVATE-LIBRARY-MENTION' : 'ALLOWED-LIBRARY-MENTION'))
  const r = await page.evaluate((paths) => window.jiwei.sources.importPaths(paths), paths)
  await page.evaluate((id) => window.jiwei.sources.update(id, { aiExcluded: true }), r.imported[1].id)
  const base = await send('引用测试起点')
  await showConversation(base.conversation.title)
  await page.locator('textarea').last().fill('@mention-private')
  await page
    .getByRole('dialog', { name: '引用资料库或笔记' })
    .getByRole('button', { name: /mention-private/ })
    .click()
  await expect(page.getByText('这份资料设为不给 AI', { exact: true }).last()).toBeVisible()
  await expect(page.getByTestId('attachment-chip')).toHaveCount(0)
  await page.locator('textarea').last().fill('@mention-allowed')
  await page.getByRole('dialog', { name: '引用资料库或笔记' }).getByRole('button', { name: 'mention-allowed', exact: true }).click()
  await expect(page.getByTestId('attachment-chip')).toHaveCount(1)
  await page.locator('textarea').last().fill('使用引用')
  await page.evaluate((id) => window.jiwei.sources.update(id, { aiExcluded: true }), r.imported[0].id)
  await page.getByRole('button', { name: '发送', exact: true }).last().click()
  await expect(page.getByText('这份资料设为不给 AI', { exact: true }).last()).toBeVisible()
  await expect(page.locator('textarea').last()).toHaveValue('使用引用')
  await expect(page.getByTestId('attachment-chip')).toHaveCount(1)
  await page.evaluate((id) => window.jiwei.sources.update(id, { aiExcluded: false }), r.imported[0].id)
  await page.getByRole('button', { name: '发送', exact: true }).last().click()
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.chat.conversations())).find((c) => c.id === base.conversation.id)?.scope)
    .toEqual({ type: 'items', notes: [], sources: [r.imported[0].id] })
  const n = await page.evaluate(() => window.jiwei.notes.create({ title: 'mention-note' }))
  await newChat()
  await page.locator('textarea').last().fill('@mention-note')
  await page.getByRole('dialog', { name: '引用资料库或笔记' }).getByRole('button', { name: 'mention-note', exact: true }).click()
  await expect(page.getByTestId('attachment-chip').filter({ hasText: 'mention-note' })).toBeVisible()
  expect(n.id).toBeTruthy()
})

test('P4 工作区旁添加并提问，就地追问短文与PDF限制', async () => {
  const note = await page.evaluate(() => window.jiwei.notes.create({ title: '附件工作区笔记' }))
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /笔记/)
  await page.getByText('附件工作区笔记', { exact: true }).first().click()
  await page.keyboard.press('ControlOrMeta+j')
  const panel = page.getByRole('complementary', { name: '积微助手' })
  await expect(panel).toBeVisible()
  const path = join(userDataDir, 'workspace-attachment.txt')
  writeFileSync(path, 'WORKSPACE-ATTACHMENT-CONTENT')
  await pickPaths([path])
  await expect(panel.getByTestId('attachment-chip')).toHaveAttribute('data-status', 'ready')
  model.setAnswer('工作区附件答复')
  await panel.locator('textarea').fill('工作区附件提问')
  await panel.getByRole('button', { name: '发送', exact: true }).click()
  await expect(panel.getByText('工作区附件答复', { exact: true })).toBeVisible()
  expect(lastRequestText()).toContain('WORKSPACE-ATTACHMENT-CONTENT')
  await page.keyboard.press('Escape')
  const sourcePath = join(userDataDir, 'inline-reading.txt')
  writeFileSync(sourcePath, '这是就地提问测试的可选正文。')
  const imported = await page.evaluate((path) => window.jiwei.sources.importPaths([path]), sourcePath)
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /资料库/)
  await page.getByText('inline-reading', { exact: true }).first().dblclick()
  await expect(page.locator('.source-text p').first()).toBeVisible()
  await page
    .locator('.source-text p')
    .first()
    .evaluate((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      const s = window.getSelection()!
      s.removeAllRanges()
      s.addRange(range)
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
  await page.getByRole('button', { name: '问 AI', exact: true }).click()
  const card = page.getByRole('dialog', { name: '就地答复' })
  await card.getByRole('textbox').fill('就地初次提问')
  await card.getByRole('button', { name: '想问什么？例如：这里为什么这样说', exact: true }).click()
  await expect(card.getByRole('textbox', { name: '追问…' })).toBeVisible()
  const inlinePath = join(userDataDir, 'inline-short.txt')
  writeFileSync(inlinePath, 'INLINE-SHORT-ATTACHMENT')
  await app.evaluate(
    ({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths })
    },
    [inlinePath, join(userDataDir, 'long.pdf')]
  )
  await card.getByRole('button', { name: '添加附件', exact: true }).click()
  await expect(card.getByTestId('attachment-chip').filter({ hasText: 'inline-short.txt' })).toHaveAttribute('data-status', 'ready')
  await expect(card.getByTestId('attachment-chip').filter({ hasText: 'long.pdf' })).toContainText('请在积微助手对话里添加这类附件')
  model.setAnswer('就地附件答复')
  await card.getByRole('textbox', { name: '追问…' }).fill('就地附件追问')
  await card.getByRole('button', { name: '发送', exact: true }).click()
  await expect(card.getByText('就地附件答复', { exact: true })).toBeVisible()
  expect(lastRequestText()).toContain('INLINE-SHORT-ATTACHMENT')
  expect(imported.imported).toHaveLength(1)
  expect(note.id).toBeTruthy()
})

test('P4 云提示只出现一次，ollama不出现；切换会话丢弃旧选择结果', async () => {
  await page.keyboard.press('Escape')
  const local = await page.evaluate(async (baseUrl) => {
    const p = await window.jiwei.providers.save({ kind: 'ollama', name: '受控本地服务', baseUrl, models: ['attachments-controlled'] })
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      attachments: { cloudNoticeSeen: false },
      ai: { ...s.ai, chat: { providerId: p.id, model: 'attachments-controlled' } }
    })
    return p.id
  }, model.url)
  await page.reload()
  await page.waitForSelector('nav')
  await newChat()
  const path = join(userDataDir, 'local-notice.txt')
  writeFileSync(path, 'LOCAL-NOTICE-CONTENT')
  await pickPaths([path])
  await expect(page.getByTestId('attachment-chip')).toHaveAttribute('data-status', 'ready')
  await expect(page.getByTestId('attachment-cloud-notice')).toHaveCount(0)
  await page.evaluate(async (providerId) => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...s.ai, chat: { providerId, model: 'attachments-controlled' } } })
  }, providerId)
  await page.reload()
  await page.waitForSelector('nav')
  await newChat()
  await pickPaths([path])
  await expect(page.getByTestId('attachment-cloud-notice')).toBeVisible()
  await page.getByRole('button', { name: '知道了', exact: true }).click()
  await expect(page.getByTestId('attachment-cloud-notice')).toHaveCount(0)
  await newChat()
  await pickPaths([path])
  await expect(page.getByTestId('attachment-chip')).toHaveAttribute('data-status', 'ready')
  await expect(page.getByTestId('attachment-cloud-notice')).toHaveCount(0)
  await newChat()
  // 延迟原生选择返回；用户切换到已有会话后，不得把旧文件加入新会话。
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => {
      await new Promise((r) => setTimeout(r, 600))
      return { canceled: false, filePaths: [path] }
    }
  }, path)
  await page.getByRole('button', { name: '添加附件', exact: true }).click()
  const base = await send('切换目标对话')
  await showConversation(base.conversation.title)
  await expect
    .poll(async () => (await page.evaluate((id) => window.jiwei.attachments.ofConversation(id), base.conversation.id)).length)
    .toBe(0)
  await page.waitForTimeout(700)
  await expect(page.getByTestId('attachment-chip')).toHaveCount(0)
  expect(local).toBeTruthy()
})

test('P5 附件空间入口、角标与未归档列表', async () => {
  await navTo(page, /资料库/)
  const count = await page.evaluate(() => window.jiwei.attachments.count())
  await expect(page.getByTestId('attachment-space-entry')).toContainText(String(count))
  await page.getByTestId('attachment-space-entry').click()
  await expect(page.getByTestId('attachment-space')).toBeVisible()
  await expect(page.getByRole('heading', { name: '附件空间', exact: true })).toBeVisible()
})

let lifecycleId = '',
  lifecycleConversation = ''
test('P5 归档到分类、查看资料库、删除灰卡不再发送、最近删除恢复', async () => {
  await newChat()
  model.setAnswer('附件生命周期答复')
  const path = join(userDataDir, 'lifecycle-file.txt')
  writeFileSync(path, 'LIFECYCLE-PRIVATE-CONTENT')
  await pickPaths([path])
  await expect(page.getByTestId('attachment-chip').first()).toHaveAttribute('data-status', 'ready')
  await page.locator('textarea').last().fill('附件生命周期测试')
  await page.getByRole('button', { name: '发送', exact: true }).last().click()
  await expect(page.getByText('附件生命周期答复', { exact: true })).toBeVisible()
  const all = await page.evaluate(() => window.jiwei.attachments.list({ state: 'unarchived' })),
    a = all.find((a) => a.name === 'lifecycle-file.txt')!
  lifecycleId = a.sourceId
  lifecycleConversation = a.conversations[0].id
  const cat = await page.evaluate(() => window.jiwei.categories.create('source', '附件归档分类')),
    count = await page.evaluate(() => window.jiwei.attachments.count())
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /资料库/)
  await page.getByTestId('attachment-space-entry').click()
  const row = page.getByTestId('attachment-space-row').filter({ hasText: 'lifecycle-file.txt' })
  await row.getByRole('checkbox').check()
  await page.getByTestId('attachment-space-actions').getByRole('button', { name: '归档到…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '归档到资料库', exact: true })
  await dialog.getByRole('combobox').selectOption(cat.id)
  await dialog.getByRole('button', { name: '归档到资料库', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.jiwei.attachments.count())).toBe(count - 1)
  await page.getByRole('button', { name: '已归档', exact: true }).click()
  await expect(row).toContainText('已归档到「附件归档分类」')
  await page.getByRole('button', { name: '查看', exact: true }).click()
  await expect(page.getByTestId('library-scroll')).toContainText('lifecycle-file')
  await showConversation('附件生命周期测试')
  await page.getByRole('button', { name: '本对话附件 1', exact: true }).click()
  await page.getByTestId('conversation-attachments').getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '确认', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('message-attachments')).toContainText('附件已删除')
  model.setAnswer('已删除附件后的答复')
  await page.locator('textarea').last().fill('继续提问')
  await page.getByRole('button', { name: '发送', exact: true }).last().click()
  await expect(page.getByText('已删除附件后的答复', { exact: true })).toBeVisible()
  expect(lastRequestText()).not.toContain('LIFECYCLE-PRIVATE-CONTENT')
  const trash = await page.evaluate(() => window.jiwei.trash.list())
  expect(trash.some((x) => x.id === lifecycleId)).toBe(true)
  await page.evaluate((id) => window.jiwei.trash.restore('source', id), lifecycleId)
  await navTo(page, /资料库/)
  await page.getByTestId('attachment-space-entry').click()
  await page.getByRole('button', { name: '未归档', exact: true }).click()
  await expect(row).toBeVisible()
  expect((await page.evaluate((id) => window.jiwei.sources.get(id), lifecycleId))?.aiExcluded).toBe(true)
})

test('P5 相同文件再附第二个对话复用一条资料；普通删除对话留下孤儿附件', async () => {
  const before = await page.evaluate(() => window.jiwei.attachments.count()),
    second = await send('第二个明确附上的对话', [lifecycleId])
  expect(await page.evaluate(() => window.jiwei.attachments.count())).toBe(before)
  let rows = await page.evaluate(() => window.jiwei.attachments.list({ state: 'unarchived' }))
  expect(rows.filter((a) => a.sourceId === lifecycleId)).toHaveLength(1)
  expect(rows.find((a) => a.sourceId === lifecycleId)?.conversations).toHaveLength(2)
  await page.evaluate(
    async ({ one, two }) => {
      await window.jiwei.chat.remove(one)
      await window.jiwei.chat.remove(two)
    },
    { one: lifecycleConversation, two: second.conversation.id }
  )
  rows = await page.evaluate(() => window.jiwei.attachments.list({ state: 'unarchived' }))
  expect(rows.find((a) => a.sourceId === lifecycleId)?.conversations).toHaveLength(0)
  await navTo(page, /资料库/)
  await page.getByTestId('attachment-space-entry').click()
  await expect(page.getByTestId('attachment-space-row').filter({ hasText: 'lifecycle-file.txt' })).toContainText('所属对话已删除')
})

test('P5 无痕草稿去重、隐藏、删除对话彻底清理', async () => {
  await newChat()
  await page.getByRole('switch', { name: '无痕', exact: true }).click()
  const path = join(userDataDir, 'incognito-owned.txt')
  writeFileSync(path, 'INCOGNITO-ATTACHMENT-CONTENT')
  await pickPaths([path])
  await expect(page.getByTestId('attachment-chip')).toHaveAttribute('data-status', 'ready')
  await pickPaths([path])
  await expect(page.getByTestId('attachment-chip')).toHaveCount(1)
  expect(JSON.stringify(await page.evaluate(() => window.jiwei.attachments.list({ state: 'all' })))).not.toContain('incognito-owned.txt')
  model.setAnswer('无痕附件答复')
  await page.locator('textarea').last().fill('无痕附件提问')
  await page.getByRole('button', { name: '发送', exact: true }).last().click()
  await expect(page.getByText('无痕附件答复', { exact: true })).toBeVisible()
  const c = (await page.evaluate(() => window.jiwei.chat.conversations())).find((c) => c.title === '无痕附件提问')!,
    [a] = await page.evaluate((id) => window.jiwei.attachments.ofConversation(id), c.id)
  expect(lastRequestText()).toContain('INCOGNITO-ATTACHMENT-CONTENT')
  await page.evaluate((id) => window.jiwei.chat.remove(id), c.id)
  expect(await page.evaluate((id) => window.jiwei.sources.get(id), a.sourceId)).toBeNull()
  expect(await page.evaluate((id) => window.jiwei.segments.list(id), a.sourceId)).toHaveLength(0)
})

test('P5 参谋短文全文、长文截断、图片、决策归属隔离与再生成', async () => {
  await navTo(page, /参谋/)
  const path = join(userDataDir, 'advisor-private.txt')
  writeFileSync(path, 'ADVISOR-PRIVATE-ATTACHMENT-MARKER')
  model.setAnswer('ADVISOR-PRIVATE-ATTACHMENT-MARKER')
  await pickPaths([path])
  await expect(page.getByTestId('attachment-chip')).toHaveAttribute('data-status', 'ready')
  await page.getByRole('textbox', { name: '参谋', exact: true }).fill('选择哪一种安排更合适？')
  await page.getByRole('button', { name: '请参谋', exact: true }).click()
  await expect(page.getByTestId('decision-memo')).toBeVisible()
  expect(lastRequestText()).toContain('<external-data source="attachment:advisor-private.txt">')
  expect(lastRequestText()).toContain('ADVISOR-PRIVATE-ATTACHMENT-MARKER')
  const [decision] = await page.evaluate(() => window.jiwei.advisor.list()),
    [a] = await page.evaluate((id) => window.jiwei.attachments.ofConversation(id), decision.id)
  expect(a.conversations[0].id).toBe(decision.id)
  expect(JSON.stringify(await page.evaluate(() => window.jiwei.advisor.list()))).not.toContain('ADVISOR-PRIVATE-ATTACHMENT-MARKER')
  await page.evaluate((id) => window.jiwei.advisor.regenerate(id), decision.id)
  expect(lastRequestText()).toContain('ADVISOR-PRIVATE-ATTACHMENT-MARKER')
  model.setAnswer('另一个对话答复')
  await send('全知识库查询参谋附件', [], null, true)
  expect(lastRequestText()).not.toContain('ADVISOR-PRIVATE-ATTACHMENT-MARKER')
  const long = await add('advisor-long.txt', '长文开始\n' + '正文'.repeat(8500) + 'ADVISOR-TAIL-MUST-NOT-BE-SENT')
  await page.evaluate((id) => window.jiwei.advisor.ask({ question: '请根据这份长文做决策', attachments: [id] }), long)
  expect(lastRequestText()).toContain('已截断为前12000字')
  expect(lastRequestText()).not.toContain('ADVISOR-TAIL-MUST-NOT-BE-SENT')
  const image = await add(
    'advisor-image.png',
    new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6AAAAABJRU5ErkJggg==', 'base64'))
  )
  await page.evaluate((id) => window.jiwei.advisor.ask({ question: '请根据这张图片给出选择', attachments: [id] }), image)
  expect(JSON.stringify(model.requests.at(-1))).toContain('image_url')
  await page.evaluate((id) => window.jiwei.advisor.remove(id), decision.id)
  expect((await page.evaluate(() => window.jiwei.attachments.list({ state: 'unarchived' }))).some((x) => x.sourceId === a.sourceId)).toBe(
    true
  )
})
