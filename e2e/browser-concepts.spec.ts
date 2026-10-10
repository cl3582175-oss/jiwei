import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'http'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clickInPage, inPage } from './fixtures/browserPage'

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let server: Server
let base = ''
let prompt = ''
let firstTab = ''
let secondTab = ''

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url?.endsWith('/chat/completions')) {
      let body = ''
      request.on('data', (data: Buffer) => {
        body += data.toString()
      })
      request.on('end', () => {
        prompt = body
        const parsed = JSON.parse(body) as { messages?: { content?: unknown }[] }
        const text = parsed.messages?.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n') ?? ''
        const ids = new Map<string, string>()
        for (const match of text.matchAll(/\[(\d+)\] 资料《([^》]+)》/g)) if (!ids.has(match[2])) ids.set(match[2], match[1])
        const answer = [...ids].map(([title, id]) => `${title} [${id}]`).join('；') || 'No source evidence'
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(
          `data: ${JSON.stringify({ id: 'test-response', object: 'chat.completion.chunk', created: 1, model: 'local-fixture', choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] })}\n\n`
        )
        response.end(
          `data: ${JSON.stringify({ id: 'test-response', object: 'chat.completion.chunk', created: 1, model: 'local-fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`
        )
      })
      return
    }
    const second = request.url === '/b'
    const title = second ? '统计课程乙' : '概率课程甲'
    const body = second
      ? '统计课程乙使用置信区间估计总体参数，样本容量越大时估计通常越稳定。课程乙的独立证据是重复抽样与区间覆盖率。'
      : '概率课程甲使用间隔重复巩固概率知识，在即将遗忘时复习并逐步拉长复习间隔。课程甲的独立证据是条件概率与独立事件。'
    response
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(
        `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head><body style="padding:32px;font:16px/1.8 sans-serif"><article><h1>${title}</h1><p>${body}</p><p>${body}通过不同例题比较这些方法，更容易理解它们之间的关系。</p></article></body></html>`
      )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-concepts-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await page.evaluate(async (url) => {
    const provider = await window.jiwei.providers.save({
      kind: 'ollama',
      name: 'Local citation fixture',
      baseUrl: `${url}/v1`,
      models: ['local-fixture']
    })
    const settings = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...settings.ai, chat: { providerId: provider.id, model: 'local-fixture' }, effort: 'off' } })
  }, base)
  // API 建立测试配置后重新加载界面，避免绕过设置页的缓存失效流程而留下旧的模型列表。
  await page.reload()
  await page.waitForSelector('nav')
  const size = process.env.JIWEI_TEST_WINDOW?.split('x').map(Number)
  if (size?.length === 2)
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0].setSize(width, height), size)
  await page.evaluate(() => window.jiwei.memory.concepts())
  // 只在临时测试档案中建立薄弱概念，避免为测试触发远端模型或改动真实学习档案。
  await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('module')
    const { join } = process.getBuiltinModule('path')
    const req = createRequire(join(app.getAppPath(), 'package.json'))
    const Database = req('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(join(app.getPath('userData'), 'profile', 'memory.db'))
    db.prepare('INSERT INTO concepts (id,name,norm,mastery,first_seen,last_seen) VALUES (?,?,?,?,?,?)').run(
      'test-concept',
      '间隔重复',
      '间隔重复',
      0.1,
      1,
      1
    )
    db.close()
  })
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('本地概念解释')
  await page.keyboard.press('Enter')
  await page.keyboard.type('间隔重复：在快要遗忘时复习，逐步增加间隔。')
  await page.getByRole('button', { name: '在笔记旁打开浏览器' }).click()
  firstTab = await page.evaluate((url) => window.jiwei.browser.open(url, { newTab: false }), `${base}/a`)
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.browser.state())).tabs.find((tab) => tab.id === firstTab)?.loading)
    .toBe(false)
})

test.afterAll(async () => {
  await app?.close()
  server?.close()
})

test('weak concepts are highlighted; hover waits before a closed-shadow hint and ask uses the existing card', async () => {
  await expect.poll(() => inPage<number>(app, `CSS.highlights.get('jw-concept')?.size ?? 0`)).toBeGreaterThan(0)
  const point = await inPage<{ x: number; y: number }>(
    app,
    `(() => { const r = [...CSS.highlights.get('jw-concept')][0].getClientRects()[0]; return { x: r.left + Math.min(2, r.width / 2), y: r.top + r.height / 2 } })()`
  )
  const geometry = await app.evaluate(async ({ webContents }, point) => {
    const wc = webContents.getAllWebContents().find((contents) => contents.getURL().endsWith('/a'))!
    return { point, zoom: wc.getZoomFactor(), viewport: await wc.executeJavaScript('({width:innerWidth,height:innerHeight})') }
  }, point)
  await test.info().attach('native-hover-geometry', { body: Buffer.from(JSON.stringify(geometry)), contentType: 'application/json' })
  await app.evaluate(({ webContents }, point) => {
    const wc = webContents.getAllWebContents().find((contents) => contents.getURL().endsWith('/a'))!
    const zoom = wc.getZoomFactor()
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) })
  }, point)
  await page.waitForTimeout(150)
  expect(await inPage<boolean>(app, `!!document.querySelector('jiwei-concept')`)).toBe(false)
  await expect.poll(() => inPage<boolean>(app, `!!document.querySelector('jiwei-concept')`)).toBe(true)
  expect(await inPage<boolean>(app, `document.querySelector('jiwei-concept').shadowRoot === null`)).toBe(true)
  const ask = JSON.parse(await inPage<string>(app, `document.querySelector('jiwei-concept').getAttribute('data-ask')`)) as {
    x: number
    y: number
  }
  await clickInPage(app, ask.x, ask.y)
  await expect(page.getByRole('dialog', { name: '就地答复' })).toBeVisible()
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.browser.state())).tabs.find((tab) => tab.id === firstTab)?.sourceId)
    .toBeTruthy()
  await page.keyboard.press('Escape')
})

test('quiet mode clears concepts and a newly inserted password field disables collection', async () => {
  await page.evaluate(async () => {
    const settings = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ browser: { ...settings.browser, proactivity: 'quiet' } })
  })
  await expect.poll(() => inPage<number>(app, `CSS.highlights.get('jw-concept')?.size ?? 0`)).toBe(0)
  await page.evaluate(async () => {
    const settings = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ browser: { ...settings.browser, proactivity: 'balanced' } })
  })
  await expect.poll(() => inPage<number>(app, `CSS.highlights.get('jw-concept')?.size ?? 0`)).toBeGreaterThan(0)
  await inPage(app, `document.body.insertAdjacentHTML('beforeend', '<input type="password">')`)
  await expect.poll(() => inPage<number>(app, `CSS.highlights.get('jw-concept')?.size ?? 0`)).toBe(0)
  await expect(page.evaluate((id) => window.jiwei.browser.saveSource(id), firstTab)).rejects.toThrow()
  await page.evaluate(({ id, url }) => window.jiwei.browser.navigate(id, url), { id: firstTab, url: `${base}/a` })
  await expect.poll(() => inPage<number>(app, `CSS.highlights.get('jw-concept')?.size ?? 0`)).toBeGreaterThan(0)
})

test('changing mastery refreshes already loaded pages without a reload', async () => {
  await page.evaluate(() => window.jiwei.memory.setConceptLevel('test-concept', 'solid'))
  await expect.poll(() => inPage<number>(app, `CSS.highlights.get('jw-concept')?.size ?? 0`)).toBe(0)
  await page.evaluate(() => window.jiwei.memory.setConceptLevel('test-concept', 'weak'))
  await expect.poll(() => inPage<number>(app, `CSS.highlights.get('jw-concept')?.size ?? 0`)).toBeGreaterThan(0)
})

test('a pending hover cannot restore a tooltip after quiet mode is enabled', async () => {
  const point = await inPage<{ x: number; y: number }>(
    app,
    `(() => { const r = [...CSS.highlights.get('jw-concept')][0].getClientRects()[0]; return { x: r.left + Math.min(2, r.width / 2), y: r.top + r.height / 2 } })()`
  )
  await app.evaluate(({ webContents }, point) => {
    const contents = webContents.getAllWebContents().find((item) => item.getURL().endsWith('/a'))!
    const zoom = contents.getZoomFactor()
    contents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 })
    contents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x * zoom), y: Math.round(point.y * zoom) })
  }, point)
  await page.waitForTimeout(100)
  await page.evaluate(async () => {
    const settings = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ browser: { ...settings.browser, proactivity: 'quiet' } })
  })
  // 等过600ms悬停截止时间，确认先前排队的回调不能在权限收紧后重新显示本地笔记。
  await page.waitForTimeout(750)
  expect(await inPage<boolean>(app, `!!document.querySelector('jiwei-concept')`)).toBe(false)
  expect(await inPage<number>(app, `CSS.highlights.get('jw-concept')?.size ?? 0`)).toBe(0)
  await page.evaluate(async () => {
    const settings = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ browser: { ...settings.browser, proactivity: 'balanced' } })
  })
  await expect.poll(() => inPage<number>(app, `CSS.highlights.get('jw-concept')?.size ?? 0`)).toBeGreaterThan(0)
})

test('changing an existing input to password immediately disables collection', async () => {
  await inPage(app, `document.body.insertAdjacentHTML('beforeend', '<input id="late-password" type="text">')`)
  await inPage(app, `document.getElementById('late-password').type = 'password'`)
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.browser.state())).tabs.find((tab) => tab.id === firstTab)?.sensitive)
    .toBe(true)
  await expect.poll(() => inPage<number>(app, `CSS.highlights.get('jw-concept')?.size ?? 0`)).toBe(0)
  await expect(page.evaluate((id) => window.jiwei.browser.saveSource(id), firstTab)).rejects.toThrow()
  await page.evaluate(({ id, url }) => window.jiwei.browser.navigate(id, url), { id: firstTab, url: `${base}/a` })
  await expect.poll(() => inPage<number>(app, `CSS.highlights.get('jw-concept')?.size ?? 0`)).toBeGreaterThan(0)
})

test('selected tabs reach the provider with separate persisted citation identities', async () => {
  secondTab = await page.evaluate((url) => window.jiwei.browser.open(url, { newTab: true }), `${base}/b`)
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.browser.state())).tabs.find((tab) => tab.id === secondTab)?.title)
    .toBe('统计课程乙')
  await page.keyboard.press('ControlOrMeta+j')
  const panel = page.getByRole('complementary', { name: /积微助手/ })
  await panel.getByRole('button', { name: '加入其他标签页' }).click()
  await page.getByRole('menuitemcheckbox', { name: '概率课程甲' }).click()
  await page.keyboard.press('Escape')
  await expect(panel).toContainText('标签页：概率课程甲')
  await panel.getByRole('textbox').fill('比较这两份课程的独立证据')
  await panel.getByRole('textbox').press('Enter')
  await expect.poll(() => prompt).toContain('条件概率与独立事件')
  expect(prompt).toContain('重复抽样与区间覆盖率')
  const state = await page.evaluate(() => window.jiwei.browser.state())
  const ids = [state.tabs.find((tab) => tab.id === firstTab)!.sourceId!, state.tabs.find((tab) => tab.id === secondTab)!.sourceId!]
  expect(ids[0]).not.toBe(ids[1])
  await expect
    .poll(async () => {
      const conversations = await page.evaluate(() => window.jiwei.chat.conversations())
      const conversation = conversations.find((item) => item.kind === 'workspace')
      if (!conversation) return []
      const messages = await page.evaluate((id) => window.jiwei.chat.messages(id), conversation.id)
      return (
        messages
          .find((message) => message.role === 'assistant' && message.status === 'done')
          ?.citations.map((citation) => citation.parentId)
          .sort() ?? []
      )
    })
    .toEqual([...ids].sort())
})

test('incognito pages never receive concept highlights and cannot join persisted source context', async () => {
  const previous = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((contents) => contents.id))
  const privateTab = await page.evaluate((url) => window.jiwei.browser.open(url, { newTab: true, incognito: true }), `${base}/a`)
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.browser.state())).tabs.find((tab) => tab.id === privateTab)?.title)
    .toBe('概率课程甲')
  const highlights = await app.evaluate(async ({ webContents }, previous) => {
    const contents = webContents.getAllWebContents().find((item) => !previous.includes(item.id) && item.getURL().endsWith('/a'))!
    return contents.executeJavaScript(`CSS.highlights.get('jw-concept')?.size ?? 0`)
  }, previous)
  expect(highlights).toBe(0)
  await expect(page.evaluate((id) => window.jiwei.browser.saveSource(id), privateTab)).rejects.toThrow(/无痕|AI/)
  await page.evaluate((id) => window.jiwei.browser.activate(id), secondTab)
  await page.getByRole('complementary', { name: /积微助手/ }).getByRole('button', { name: '加入其他标签页' }).click()
  await expect(page.getByRole('menuitemcheckbox', { name: '概率课程甲' })).toHaveCount(1)
  await page.keyboard.press('Escape')
})

test('removing a concept clears all loaded pages', async () => {
  await page.evaluate(() => window.jiwei.memory.removeConcept('test-concept'))
  await expect.poll(() => inPage<number>(app, `CSS.highlights.get('jw-concept')?.size ?? 0`)).toBe(0)
})
