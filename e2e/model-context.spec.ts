import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchRagApp } from './fixtures/ragApp'
import { askInApp } from './fixtures/ragChat'
import { textOf, type ModelRequest } from './fixtures/attachment-model'

const directory = mkdtempSync(join(tmpdir(), 'jiwei-context-'))
let app: ElectronApplication,
  page: Page,
  server: Server,
  providerId = '',
  sourceId = ''
const requests: ModelRequest[] = []
let reject = 0,
  toolOverflow = 0
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/models') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ data: [{ id: 'context-controlled', context_length: 1000000 }] }))
      return
    }
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      const body = JSON.parse(raw) as ModelRequest
      if (body.stream) requests.push(body)
      const input = Math.ceil(JSON.stringify(body.messages).length / 4) + Math.ceil(JSON.stringify(body.tools ?? []).length / 4)
      if (body.stream && toolOverflow === 1) {
        toolOverflow = 2
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'controlled-tool',
              model: 'context-controlled',
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'read-before-overflow',
                        type: 'function',
                        function: { name: 'knowledge_search', arguments: JSON.stringify({ query: '窗口证据', sourceIds: [sourceId] }) }
                      }
                    ]
                  },
                  finish_reason: null
                }
              ]
            }) +
            '\n\n'
        )
        res.end(
          'data: ' +
            JSON.stringify({ id: 'controlled-tool', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) +
            '\n\ndata: [DONE]\n\n'
        )
        return
      }
      if (body.stream && toolOverflow === 2) {
        toolOverflow = 0
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'maximum context length is 16384 tokens' } }))
        return
      }
      if (body.stream && (reject > 0 || input + (body.max_tokens ?? 0) > 32768)) {
        if (reject > 0) reject--
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'maximum context length is 32768 tokens' } }))
        return
      }
      const base = { id: 'controlled-context', object: 'chat.completion.chunk', created: 1, model: 'context-controlled' }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(
        'data: ' +
          JSON.stringify({
            ...base,
            choices: [{ index: 0, delta: { role: 'assistant', content: '根据提供的证据回答 [1]。' }, finish_reason: null }]
          }) +
          '\n\n'
      )
      res.write(
        'data: ' +
          JSON.stringify({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 }
          }) +
          '\n\n'
      )
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  app = await launchRagApp(directory)
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  providerId = await page.evaluate(
    async (baseUrl) => {
      const p = await window.jiwei.providers.save({
        kind: 'custom',
        name: '受控上下文',
        baseUrl,
        apiKey: 'controlled-test-key',
        models: ['context-controlled']
      })
      await window.jiwei.providers.fetchModels(p.id)
      const s = await window.jiwei.settings.get()
      await window.jiwei.settings.set({
        ai: { ...s.ai, chat: { providerId: p.id, model: 'context-controlled' } },
        retrieval: { autoUpgrade: false, mode: 'off' }
      })
      return p.id
    },
    `http://127.0.0.1:${(server.address() as { port: number }).port}`
  )
  const path = join(directory, 'Synthetic-window.md')
  writeFileSync(
    path,
    Array.from({ length: 100 }, (_, n) => `# 章节${n}\n\n窗口证据${n}。${'这是完整的合成资料正文。'.repeat(55)}终止标记${n}`).join('\n\n')
  )
  sourceId = (await page.evaluate((path) => window.jiwei.sources.importPaths([path]), path)).imported[0].id
  await expect
    .poll(async () => (await page.evaluate((id) => window.jiwei.segments.list(id), sourceId)).length, { timeout: 15000 })
    .toBeGreaterThan(50)
})
test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((r) => server?.close(() => r()))
})

const ask = () =>
  askInApp(page, {
    providerId,
    model: 'context-controlled',
    text: '窗口证据包含什么？',
    effort: 'high',
    scope: { type: 'items', notes: [], sources: [sourceId] },
    incognito: true
  })
const text = (r: ModelRequest) => r.messages.map((m) => textOf(m.content)).join('\n')
test('an explicit overflow persists the learned limit and automatically retries with excerpts', async () => {
  reject = 1
  const before = requests.length
  const response = await ask()
  expect(response.message.status).toBe('done')
  const sent = requests.slice(before)
  expect(sent).toHaveLength(2)
  expect(text(sent[0])).toContain('终止标记99')
  expect(text(sent[0])).toContain('以下是用户指定资料的全文')
  expect(text(sent[1])).not.toContain('以下是用户指定资料的全文')
  expect(sent[1].max_tokens).toBeLessThan(32768)
  expect(text(sent[1]).length).toBeLessThan(text(sent[0]).length / 2)
  const p = (await page.evaluate(() => window.jiwei.providers.list())).find((p) => p.id === providerId)!
  expect(p.modelCaps['context-controlled'].learnedContext).toBe(32768)
  expect(p.modelCaps['context-controlled'].reportedContext).toBeUndefined()
})
test('a second overflow ends the turn instead of an unbounded retry', async () => {
  reject = 3
  const before = requests.length
  const response = await ask()
  expect(response.message.status).toBe('error')
  expect(requests.length - before).toBe(2)
  reject = 0
})
test('context presets, custom value and return-to-auto survive settings reload', async () => {
  await page.reload()
  await page.waitForSelector('nav')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')
  await page.getByRole('button', { name: 'AI 模型', exact: true }).click()
  await page.getByRole('button', { name: /^受控上下文 http/ }).click()
  const row = page.locator('[data-model="context-controlled"]')
  const chip = row.getByRole('button', { name: /上下文/ })
  await expect(chip).toContainText('错误学习')
  await chip.click()
  await page.getByRole('button', { name: '128K', exact: true }).click()
  await expect(chip).toContainText('手动设定')
  await chip.click()
  await page.getByRole('spinbutton', { name: '上下文词元数' }).fill('96000')
  await page.getByRole('button', { name: '保存', exact: true }).last().click()
  await page.reload()
  await page.waitForSelector('nav')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')
  await page.getByRole('button', { name: 'AI 模型', exact: true }).click()
  await page.getByRole('button', { name: /^受控上下文 http/ }).click()
  await expect(chip).toContainText('96K')
  await chip.click()
  await page.getByRole('button', { name: '恢复自动', exact: true }).click()
  await expect(chip).toContainText('错误学习')
  expect(
    (await page.evaluate(() => window.jiwei.providers.list())).find((p) => p.id === providerId)!.modelCaps['context-controlled'].context
  ).toBeUndefined()
})

test('a model tool step followed by overflow learns without replaying the tool', async () => {
  toolOverflow = 1
  const before = requests.length
  const response = await ask()
  expect(response.message.status).toBe('error')
  expect(response.message.steps.filter((s) => s.tool === 'knowledge_search')).toHaveLength(1)
  expect(requests.length - before).toBe(2)
  const p = (await page.evaluate(() => window.jiwei.providers.list())).find((p) => p.id === providerId)!
  expect(p.modelCaps['context-controlled'].learnedContext).toBe(16384)
})
