import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import Database from 'better-sqlite3'
import { navTo } from './fixtures/nav'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page, server: Server
let answer = '',
  providerId = ''
type RequestMessage = { role: string; content: unknown }
const requests: RequestMessage[][] = []
const userDataDir = mkdtempSync(join(tmpdir(), 'jiwei-ui-'))
const textOf = (value: unknown): string =>
  typeof value === 'string' ? value : Array.isArray(value) ? value.map((part) => part.text ?? '').join('') : ''
const fence = (node: unknown): string => `\`\`\`jiwei-ui\n${JSON.stringify(node)}\n\`\`\``
const table = {
  type: 'table',
  title: '人数对比',
  columns: [
    { key: 'name', label: '名称' },
    { key: 'count', label: '人数', kind: 'number' }
  ],
  rows: [
    { name: '第一行', count: 5 },
    { name: '第二行', count: 2 },
    { name: '第三行', count: 4 },
    { name: '第四行', count: 1 },
    { name: '第五行', count: 3 }
  ]
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const input = JSON.parse(body || '{}')
      requests.push(input.messages)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const user = textOf((input.messages as RequestMessage[]).filter((m) => m.role === 'user').at(-1)?.content)
      const external = /(`{3,}jiwei-ui-blocked[^\n]*\n[\s\S]*?\n`{3,})/.exec(user)?.[1]
      const text = user.includes('外部组件复述') && external ? external : answer
      // 大组件仍按规定的 5–15 字符片段流式输出，保持断言原有超时。
      const chunkSize = text.length > 2400 ? 15 : 10
      let offset = 0
      const send = (delta: unknown, finish: string | null): void => {
        res.write(
          `data: ${JSON.stringify({ id: 'ui', object: 'chat.completion.chunk', created: 1, model: 'test-ui', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        )
      }
      const interval = setInterval(() => {
        if (offset < text.length) {
          send({ content: text.slice(offset, offset + chunkSize) }, null)
          offset += chunkSize
        } else {
          clearInterval(interval)
          send({}, 'stop')
          res.end('data: [DONE]\n\n')
        }
      }, 20)
      res.on('close', () => clearInterval(interval))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      JIWEI_SKIP_ONBOARDING: '1',
      JIWEI_LANG: 'zh-CN',
      JIWEI_IMPORT_PROVIDERS_FROM: '',
      JIWEI_TEST_NETWORK: '1',
      JIWEI_TEST_UI_FULL: '1'
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  providerId = await page.evaluate(
    async (baseUrl) => {
      const p = await window.jiwei.providers.save({ kind: 'ollama', name: '受控界面测试', baseUrl, models: ['test-ui'] })
      const s = await window.jiwei.settings.get()
      await window.jiwei.settings.set({
        ai: { ...s.ai, chat: { providerId: p.id, model: 'test-ui' }, effort: 'off', ui: { ...s.ai.ui, localModels: 'normal' } }
      })
      return p.id
    },
    `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  )
  await navTo(page, /AI 对话/)
})
test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((r) => server?.close(() => r()))
})

async function ask(text: string, response: string): Promise<void> {
  answer = response
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  // 走真实发送入口，使用本用例独立的空知识库。
  await page.evaluate(async (providerId) => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...s.ai, chat: { providerId, model: 'test-ui' } } })
  }, providerId)
  await expect(page.getByRole('button', { name: '模型', exact: true })).toContainText('test-ui')
  await page.getByRole('textbox').last().fill(text)
  await page.getByRole('textbox').last().press('Enter')
}
const block = () => page.getByTestId('ui-block').last()
async function done(): Promise<void> {
  await expect(block()).toHaveAttribute('data-ui-state', 'ready')
}

test('P2 流式表格逐行显示、结束后排序', async () => {
  await ask('流式表格', `下面逐行显示数据。\n\n${fence(table)}\n\n数据已经列全。`)
  await expect(block()).toHaveAttribute('data-ui-state', 'streaming')
  const firstFrame = await page.waitForFunction(
    () => {
      const frame = [...document.querySelectorAll('[data-testid="ui-block"]')].at(-1)
      const rows = frame?.querySelectorAll('tbody tr').length ?? 0
      return frame?.getAttribute('data-ui-state') === 'streaming' && rows > 0 && rows < 5 ? rows : false
    },
    undefined,
    { timeout: 5000 }
  )
  const first = (await firstFrame.jsonValue()) as number
  await page.screenshot({ path: test.info().outputPath('table-streaming-1.png') })
  await expect.poll(() => block().locator('tbody tr').count()).toBeGreaterThan(first)
  const rows = await block().locator('tbody tr').allTextContents()
  expect(rows.every((r) => /第[一二三四五]行/.test(r))).toBe(true)
  await page.screenshot({ path: test.info().outputPath('table-streaming-2.png') })
  await done()
  await expect(block().locator('tbody tr')).toHaveCount(5)
  await block().getByRole('button', { name: '人数' }).click()
  await expect(block().locator('tbody tr').first()).toContainText('第四行')
})
test('P2 非法 JSON 和未知类型可展开原文，错位图表退回表格', async () => {
  for (const response of ['```jiwei-ui\n{坏的\n```', fence({ type: 'unknown', title: '未知' })]) {
    await ask('坏数据', response)
    await expect(block()).toHaveAttribute('data-ui-state', 'fallback')
    await expect(block().getByText('组件生成失败')).toBeVisible()
    await block().getByText('组件生成失败').click()
    await expect(block().locator('pre')).toBeVisible()
  }
  await ask('错位图表', fence({ type: 'chart', categories: ['一', '二'], kind: 'bar', series: [{ name: '次数', data: [2] }] }))
  await expect(block()).toHaveAttribute('data-ui-state', 'fallback')
  await expect(block()).toContainText('没能显示成组件，已改为文字')
  await expect(block().locator('table')).toBeVisible()
})
test('P2 适中档第四个组件折叠显示', async () => {
  await ask('四个组件', Array.from({ length: 4 }, (_, i) => fence({ type: 'list', items: [{ text: `条目${i}` }] })).join('\n\n'))
  await expect(page.getByText('还有 1 个组件，展开查看')).toBeVisible()
})
test('P2 窄组件自身宽度让分栏上下排', async () => {
  await ask(
    '布局',
    fence({
      type: 'columns',
      children: [
        { type: 'list', items: [{ text: '甲' }] },
        { type: 'chart', kind: 'bar', categories: ['一', '二'], series: [{ name: '数', data: [1, 2] }] }
      ]
    })
  )
  await done()
  const cols = block().getByTestId('ui-columns')
  await expect(cols).toHaveAttribute('data-layout', 'columns')
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>('[data-testid="ui-block"]')!
    frame.style.width = '360px'
  })
  await expect(cols).toHaveAttribute('data-layout', 'stack')
  await page.screenshot({ path: test.info().outputPath('columns-narrow.png') })
})
test('P2 停止生成保留已完整的行并禁止操作', async () => {
  await ask('停止生成', fence({ ...table, rows: Array.from({ length: 25 }, (_, i) => ({ name: `第${i}行`, count: i })) }))
  await expect.poll(() => block().locator('tbody tr').count()).toBeGreaterThan(0)
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(block()).toContainText('未完成')
  await expect(block().locator('tbody tr')).not.toHaveCount(0)
  await expect(block().getByRole('button', { name: '人数' })).toBeDisabled()
})
test('P2 组件菜单改成文字与复制 Markdown', async () => {
  await ask('菜单', fence({ type: 'table', columns: [{ key: 'n', label: '人数' }], rows: [{ n: 3 }] }))
  await done()
  await block().getByRole('button', { name: '组件菜单' }).click()
  await block().getByRole('menuitem', { name: '复制为 Markdown' }).click()
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('| 人数 |\n| --- |\n| 3 |')
  await block().getByRole('button', { name: '组件菜单' }).click()
  await block().getByRole('menuitem', { name: '改成文字' }).click()
  await expect(block()).toHaveAttribute('data-ui-display', 'text')
})
test('P3 关闭目录仍渲染旧组件，结束后可读取 ui_text', async () => {
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...s.ai, ui: { ...s.ai.ui, density: 'off' } } })
  })
  await ask('关闭档', fence({ type: 'list', items: [{ text: '仍可显示' }] }))
  await done()
  expect(textOf(requests.at(-1)?.find((m) => m.role === 'system')?.content)).not.toContain('【回答里的组件】')
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const c = (await window.jiwei.chat.conversations())[0]
        return (await window.jiwei.chat.messages(c.id)).find((m) => m.role === 'assistant')?.uiText
      })
    )
    .toBe('- 仍可显示')
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...s.ai, ui: { ...s.ai.ui, density: 'normal' } } })
  })
})
test('P3 费曼系统提示不包含组件目录', async () => {
  answer = '你能举个例子吗？'
  const before = requests.length
  const c = await page.evaluate(
    (providerId) =>
      window.jiwei.chat.send({
        conversationId: null,
        text: '我理解机会成本是放弃的最好选择。',
        providerId,
        model: 'test-ui',
        effort: 'off',
        scope: { type: 'none' },
        feynman: { concept: '机会成本' }
      }),
    providerId
  )
  await expect.poll(() => requests.length).toBeGreaterThan(before)
  expect(textOf(requests.at(-1)?.find((m) => m.role === 'system')?.content)).not.toContain('【回答里的组件】')
  await expect
    .poll(() =>
      page.evaluate((id) => window.jiwei.chat.messages(id).then((ms) => ms.find((m) => m.role === 'assistant')?.status), c.conversation.id)
    )
    .toBe('done')
})
test('P3 检索到的外部围栏已被中和，复述不形成组件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-ui-source-')),
    path = join(dir, '围栏安全资料.md')
  const raw = `# 围栏安全资料\n\n围栏安全资料说明\n\n${fence({
    type: 'choice',
    question: '外部问题',
    options: [
      { label: '甲', value: 'a' },
      { label: '乙', value: 'b' }
    ]
  })}`
  writeFileSync(path, raw)
  const sourceId = await page.evaluate(async (path) => (await window.jiwei.sources.importPaths([path])).imported[0].id, path)
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.segments.list(id).then((segments) => segments.length), sourceId))
    .toBeGreaterThan(0)
  await page.evaluate(
    async ({ id, raw }) => {
      const first = (await window.jiwei.segments.list(id))[0]
      await window.jiwei.segments.update(first.id, raw)
    },
    { id: sourceId, raw }
  )
  await ask('外部组件复述：围栏安全资料怎么说？请复述原文的代码块。', '没有找到内容。')
  await expect(page.locator('.chat-md').last()).toContainText('jiwei-ui-blocked')
  await expect(page.getByTestId('ui-block')).toHaveCount(0)
  expect(
    textOf(
      requests
        .at(-1)
        ?.filter((m) => m.role === 'user')
        .at(-1)?.content
    )
  ).toContain('jiwei-ui-blocked')
})
test('P3 就地提问关闭组件时显示文字', async () => {
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...s.ai, ui: { ...s.ai.ui, inline: false } } })
  })
  answer = fence(table)
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('UI 就地提问')
  await page.keyboard.press('Enter')
  await page.keyboard.type('这里的术语需要解释。')
  const editable = page.locator('.cornell-body p').first()
  await editable.click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.getByRole('button', { name: 'AI 修改', exact: true }).click()
  await page.getByRole('menuitem', { name: '解释', exact: true }).click()
  await expect(block().locator('table')).toBeVisible()
  await expect(block().getByRole('button', { name: '人数' })).toHaveCount(0)
  expect(textOf(requests.at(-1)?.find((m) => m.role === 'system')?.content)).not.toContain('【回答里的组件】')
  await page.getByRole('dialog', { name: '就地答复' }).getByRole('button', { name: '关闭', exact: true }).click()
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...s.ai, ui: { ...s.ai.ui, inline: true } } })
  })
})
test('P4 日程建议经确认写入，取消一条不写入，已有数据独立显示', async () => {
  await navTo(page, /AI 对话/)
  await page.evaluate(() =>
    window.jiwei.plan.eventSave({
      title: '已有会面',
      kind: 'event',
      startAt: new Date('2026-10-19T09:00').getTime(),
      endAt: new Date('2026-10-19T10:00').getTime()
    })
  )
  const range = { from: '2026-10-19', to: '2026-10-25' }
  await ask(
    '日程预览',
    fence({
      type: 'schedule',
      range,
      proposals: [
        { title: '建议复习', start: '2026-10-19T19:00', end: '2026-10-19T21:00' },
        { title: '取消的复习', start: '2026-10-21T19:00', end: '2026-10-21T21:00' }
      ]
    })
  )
  await done()
  await expect(block().getByTestId('ui-existing-event')).toContainText('已有会面')
  await expect(block().getByText('建议', { exact: true })).toHaveCount(2)
  await block().getByRole('checkbox', { name: '取消的复习' }).uncheck()
  await block().getByRole('button', { name: '排进日历', exact: true }).click()
  const confirm = block().getByTestId('ui-confirm')
  await expect(confirm).toContainText('建议复习')
  await expect(confirm).not.toContainText('取消的复习')
  await page.screenshot({ path: test.info().outputPath('schedule-confirm.png') })
  const read = () =>
    page.evaluate(() =>
      window.jiwei.plan.events({ startAt: new Date('2026-10-19T00:00').getTime(), endAt: new Date('2026-10-26T00:00').getTime() })
    )
  expect((await read()).filter((e) => e.title === '建议复习')).toHaveLength(0)
  await confirm.getByRole('button', { name: '确认', exact: true }).click()
  await expect(block()).toContainText('已排进日历')
  const events = await read()
  expect(events.filter((e) => e.title === '建议复习')).toHaveLength(1)
  expect(events.some((e) => e.title === '取消的复习')).toBe(false)
})
test('P4 待办完成和草稿新建均确认', async () => {
  const id = await page.evaluate(() => window.jiwei.actions.create('已有行动项', null).then((a) => a.id))
  await ask('待办', fence({ type: 'tasks', filter: { scope: 'open' }, drafts: [{ title: '新待办甲' }, { title: '新待办乙' }] }))
  await done()
  await block().getByRole('checkbox', { name: '已有行动项' }).check()
  expect(await page.evaluate((id) => window.jiwei.actions.list().then((rows) => rows.find((a) => a.id === id)?.status), id)).toBe('open')
  await block().getByTestId('ui-confirm').getByRole('button', { name: '确认', exact: true }).click()
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.actions.list().then((rows) => rows.find((a) => a.id === id)?.status), id))
    .toBe('done')
  await block().getByRole('button', { name: '新建这些待办', exact: true }).click()
  await block().getByTestId('ui-confirm').getByRole('button', { name: '确认', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.jiwei.actions.list().then((rows) => rows.filter((r) => /^新待办/.test(r.title)).length)))
    .toBe(2)
})
test('P4 写入部分失败时保留确认面板，重试不重复写已成功条目', async () => {
  await ask(
    '部分失败',
    fence({
      type: 'schedule',
      range: { from: '2026-10-19', to: '2026-10-25' },
      proposals: [
        { title: '第一次已成功', start: '2026-10-22T19:00', end: '2026-10-22T20:00' },
        { title: '缺少方向', start: '2026-10-23T19:00', end: '2026-10-23T20:00', goalId: 'missing-goal' }
      ]
    })
  )
  await done()
  await block().getByRole('button', { name: '排进日历', exact: true }).click()
  const panel = block().getByTestId('ui-confirm')
  await panel.getByRole('button', { name: '确认', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('Direction not found')
  await panel.getByRole('button', { name: '确认', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('Direction not found')
  const written = await page.evaluate(() =>
    window.jiwei.plan.events({ startAt: new Date('2026-10-19T00:00').getTime(), endAt: new Date('2026-10-26T00:00').getTime() })
  )
  expect(written.filter((e) => e.title === '第一次已成功')).toHaveLength(1)
  await panel.getByRole('button', { name: '取消', exact: true }).click()
})
test('P4 dataAccess 关闭时不调用日程接口，只显示建议', async () => {
  await app.evaluate(({ ipcMain }) => {
    const channel = 'plan:events'
    const old = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown> }
    )._invokeHandlers.get(channel)
    if (!old) throw new Error('Missing plan IPC handler')
    let calls = 0
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args) => {
      calls++
      return old(event, ...args)
    })
    const state = globalThis as unknown as { uiReadCalls: () => number; resetUiReadCalls: () => void; restorePlanRead: () => void }
    state.uiReadCalls = () => calls
    state.resetUiReadCalls = () => {
      calls = 0
    }
    state.restorePlanRead = () => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, old)
    }
  })
  await page.evaluate(() =>
    window.jiwei.plan.events({ startAt: new Date('2026-10-19T00:00').getTime(), endAt: new Date('2026-10-26T00:00').getTime() })
  )
  expect(await app.evaluate(() => (globalThis as unknown as { uiReadCalls: () => number }).uiReadCalls())).toBe(1)
  await app.evaluate(() => (globalThis as unknown as { resetUiReadCalls: () => void }).resetUiReadCalls())
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...s.ai, ui: { ...s.ai.ui, dataAccess: false } } })
  })
  await ask(
    '只看建议',
    fence({
      type: 'schedule',
      range: { from: '2026-10-19', to: '2026-10-25' },
      proposals: [{ title: '只看建议', start: '2026-10-19T19:00', end: '2026-10-19T20:00' }]
    })
  )
  await done()
  await expect(block()).toContainText('已关闭读取你的数据，这里只显示建议')
  expect(await app.evaluate(() => (globalThis as unknown as { uiReadCalls: () => number }).uiReadCalls())).toBe(0)
  await app.evaluate(() => (globalThis as unknown as { restorePlanRead: () => void }).restorePlanRead())
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...s.ai, ui: { ...s.ai.ui, dataAccess: true } } })
  })
})
test('P4 改成文字与清单状态重新加载后保留，删除对话清理状态', async () => {
  await ask('持久化', fence({ type: 'list', items: [{ text: '勾选并保存' }], checkable: true }))
  await done()
  await block().getByRole('checkbox', { name: '勾选并保存' }).check()
  await block().getByRole('button', { name: '组件菜单' }).click()
  await block().getByRole('menuitem', { name: '改成文字' }).click()
  const id = await page.evaluate(async () => (await window.jiwei.chat.conversations())[0].id)
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /AI 对话/)
  await page.getByRole('button', { name: /持久化/ }).click()
  await expect(block()).toHaveAttribute('data-ui-display', 'text')
  const messageId = await page.evaluate((id) => window.jiwei.chat.messages(id).then((ms) => ms.find((m) => m.role === 'assistant')!.id), id)
  const state = await page.evaluate((messageId) => window.jiwei.ui.states(messageId), messageId)
  expect(state.b0).toEqual(expect.objectContaining({ asText: true, checked: { 0: true } }))
  await block().getByRole('button', { name: '组件菜单' }).click()
  await block().getByRole('menuitem', { name: '恢复成组件' }).click()
  await expect(block().getByRole('checkbox', { name: '勾选并保存' })).toBeChecked()
  await page.evaluate((id) => window.jiwei.chat.remove(id), id)
  const dataDir = await page.evaluate(() => window.jiwei.app.info().then((info) => info.dataDir))
  expect(relative(realpathSync(userDataDir), realpathSync(dataDir)).startsWith('..')).toBe(false)
  const db = new Database(join(dataDir, 'jiwei.db'), { readonly: true, fileMustExist: true })
  try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM ui_states WHERE message_id=?').get(messageId)).toEqual({ n: 0 })
  } finally {
    db.close()
  }
})

test('P4 笔记行与掌握度读取真实笔记，删除后不显示旧内容', async () => {
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('组件真实笔记')
  await page.keyboard.press('Enter')
  await page.keyboard.type('笔记导言')
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '组件真实笔记' }).then((ns) => ns.length))).toBe(1)
  const id = await page.evaluate(async () => {
    const note = (await window.jiwei.notes.list({ search: '组件真实笔记' }))[0]
    await window.jiwei.proposals.create({
      noteId: note.id,
      title: '加入测试行',
      auto: true,
      ops: [
        {
          op: 'insert_row',
          afterRowId: null,
          cue: [{ type: 'paragraph', content: [{ type: 'text', text: '真实线索' }] }],
          body: [{ type: 'paragraph', content: [{ type: 'text', text: '真实笔记正文' }] }]
        }
      ]
    })
    return note.id
  })
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.notes.blocks(id).then((bs) => bs.some((b) => b.text === '真实线索')), id))
    .toBe(true)
  await navTo(page, /AI 对话/)
  await ask('查看笔记行', fence({ type: 'note', noteId: id }))
  await done()
  await expect(block()).toContainText('真实线索')
  await expect(block()).toContainText('真实笔记正文')
  await ask('查看掌握度', fence({ type: 'mastery', scope: { kind: 'note', id } }))
  await done()
  await expect(block()).toContainText('组件真实笔记')
  await page.evaluate((id) => window.jiwei.notes.trash(id), id)
  await ask('删除后笔记卡', fence({ type: 'note', noteId: id }))
  await done()
  await expect(block()).toContainText('这篇笔记已不可用')
  await expect(block()).not.toContainText('真实笔记正文')
})

test('P4 资料片段由 IPC 读取并可跳回出处，隐藏资料不可读取', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-ui-excerpt-')),
    path = join(dir, '片段出处.md')
  writeFileSync(path, '# 片段出处\n\n这段原文只存在于真实资料中。')
  const id = await page.evaluate(async (path) => (await window.jiwei.sources.importPaths([path])).imported[0].id, path)
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.segments.list(id).then((s) => s.some((r) => r.text.includes('这段原文'))), id))
    .toBe(true)
  const segmentId = await page.evaluate(
    (id) => window.jiwei.segments.list(id).then((s) => s.find((r) => r.text.includes('这段原文'))!.id),
    id
  )
  await ask('查看片段', fence({ type: 'excerpt', segmentId }))
  await done()
  await expect(block()).toContainText('这段原文只存在于真实资料中。')
  await expect(block().getByRole('button', { name: /片段出处/ })).toBeVisible()
  await block()
    .getByRole('button', { name: /片段出处/ })
    .click()
  await expect(page.getByRole('article')).toContainText('这段原文只存在于真实资料中。')
  await page.getByRole('button', { name: '关闭资料', exact: true }).click()
  await navTo(page, /AI 对话/)
  await page.evaluate((id) => window.jiwei.sources.update(id, { aiExcluded: true }), id)
  await ask('不可读取的片段', fence({ type: 'excerpt', segmentId }))
  await done()
  await expect(block()).toContainText('这段原文已不可用')
  await expect(block()).not.toContainText('这段原文只存在于真实资料中。')
})
test('P4 清单只把未勾选项确认为待办，重复点击不会重复写入', async () => {
  await ask(
    '清单待办',
    fence({ type: 'list', checkable: true, items: [{ text: '已经做完' }, { text: '清单待办甲' }, { text: '清单待办乙' }] })
  )
  await done()
  await block().getByRole('checkbox', { name: '已经做完' }).check()
  await block().getByRole('button', { name: '变成待办', exact: true }).click()
  const panel = block().getByTestId('ui-confirm')
  await expect(panel).not.toContainText('已经做完')
  expect(await page.evaluate(() => window.jiwei.actions.list().then((rows) => rows.filter((r) => /^清单待办/.test(r.title)).length))).toBe(
    0
  )
  await panel.getByRole('button', { name: '确认', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.jiwei.actions.list().then((rows) => rows.filter((r) => /^清单待办/.test(r.title)).length)))
    .toBe(2)
  await expect(block().getByRole('button', { name: '变成待办', exact: true })).toBeDisabled()
})

test.describe('P5', () => {
  test.describe.configure({ mode: 'default' })
  const lastUser = () =>
    textOf(
      requests
        .at(-1)
        ?.filter((m) => m.role === 'user')
        .at(-1)?.content
    )
  const replied = async (action: string) => {
    await expect.poll(lastUser).toContain(`action="${action}"`)
    await expect(page.locator('.chat-md').last()).toContainText('收到操作')
  }
  test('选项传真实 ui-event，发送后旧回答只读', async () => {
    await ask(
      '选择练习范围',
      fence({
        type: 'choice',
        question: '练什么？',
        options: [
          { label: '练习概率', value: 'probability' },
          { label: '练习统计', value: 'statistics' }
        ]
      })
    )
    await done()
    const original = block()
    await expect(original.getByRole('button', { name: '练习概率', exact: true })).toBeVisible()
    answer = '收到操作'
    await original.getByRole('button', { name: '练习概率', exact: true }).click()
    await replied('choose')
    expect(lastUser()).toContain('"value":"probability"')
    await expect(page.getByTestId('ui-block').first().getByRole('button', { name: '练习概率', exact: true })).toBeDisabled()
    await expect(page.getByText('练习概率', { exact: true }).last()).toBeVisible()
  })
  test('表单必填校验、逐行用户消息和带类型值的事件', async () => {
    await ask(
      '表单条件',
      fence({
        type: 'form',
        fields: [
          { key: 'topic', label: '主题', kind: 'text', required: true },
          { key: 'hours', label: '时数', kind: 'number', min: 1, max: 12, required: true },
          {
            key: 'mode',
            label: '方式',
            kind: 'select',
            options: [
              { label: '阅读', value: 'reading' },
              { label: '练习', value: 'practice' }
            ],
            value: 'reading'
          },
          { key: 'date', label: '日期', kind: 'date' },
          { key: 'days', label: '天数', kind: 'slider', min: 1, max: 7, value: 3 },
          { key: 'remind', label: '提醒', kind: 'toggle', value: false }
        ]
      })
    )
    await done()
    await expect(block().getByRole('button', { name: '提交', exact: true })).toBeVisible()
    await expect(block().getByRole('button', { name: '提交', exact: true })).toBeDisabled()
    await block().getByRole('textbox', { name: '主题', exact: true }).fill('概率')
    await block().getByRole('spinbutton', { name: '时数', exact: true }).fill('2')
    await block().getByRole('checkbox', { name: '提醒', exact: true }).check()
    answer = '收到操作'
    await block().getByRole('button', { name: '提交', exact: true }).click()
    await replied('submit')
    expect(lastUser()).toContain('主题：概率\n时数：2')
    expect(lastUser()).toContain('"hours":2')
    expect(lastUser()).toContain('"remind":true')
  })
  test('编辑表格只发送 changes，换呈现发送原节点', async () => {
    await ask(
      '编辑数据',
      fence({ type: 'table', editable: true, columns: [{ key: 'n', label: '人数', kind: 'number' }], rows: [{ n: 3 }] })
    )
    await done()
    await block().getByRole('cell', { name: '3', exact: true }).dblclick()
    await expect(block().getByRole('spinbutton')).toBeVisible()
    await block().getByRole('spinbutton').fill('5')
    await block().getByRole('spinbutton').press('Enter')
    answer = '收到操作'
    await block().getByRole('button', { name: '按这个改', exact: true }).click()
    await replied('edit')
    expect(lastUser()).toContain('"changes":[{"row":0,"col":"n","from":3,"to":5}]')
    await ask('换呈现', fence({ type: 'list', items: [{ text: '比较两种方法' }] }))
    await done()
    await block().getByRole('button', { name: '组件菜单' }).click()
    await expect(block().getByRole('menuitem', { name: '换一种呈现' })).toBeVisible()
    answer = '收到操作'
    await block().getByRole('menuitem', { name: '换一种呈现' }).click()
    await replied('restyle')
    expect(lastUser()).toContain('"node":{"type":"list"')
  })
  test('三道练习核对，一道错题经确认写入，三行保存后可读', async () => {
    await ask(
      '练习三题',
      fence({
        type: 'quiz',
        title: '组件三题练习',
        items: [
          { q: '一加一？', options: ['一', '二'], answer: 1, explain: '相加是二' },
          { q: '二加二？', options: ['三', '四'], answer: 1, explain: '相加是四' },
          { q: '三加三？', options: ['五', '六'], answer: 1, explain: '相加是六' }
        ]
      })
    )
    await done()
    await expect(block().getByRole('button', { name: '核对', exact: true })).toBeVisible()
    for (const [i, label] of ['一', '四', '六'].entries()) {
      await block().getByRole('radio', { name: label, exact: true }).check()
      await block().getByRole('button', { name: '核对', exact: true }).click()
      await expect(block()).toContainText(i === 0 ? '不正确' : '正确')
      if (i < 2) await block().getByRole('button', { name: '下一题', exact: true }).click()
    }
    const before = await page.evaluate(() => window.jiwei.mistakes.list().then((ms) => ms.length))
    await block().getByRole('button', { name: '把做错的加入错题本', exact: true }).click()
    const panel = block().getByTestId('ui-confirm')
    await expect(panel).toContainText('一加一？')
    await expect(panel).not.toContainText('二加二？')
    expect(await page.evaluate(() => window.jiwei.mistakes.list().then((ms) => ms.length))).toBe(before)
    await panel.getByRole('button', { name: '确认', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.jiwei.mistakes.list().then((ms) => ms.length))).toBe(before + 1)
    const mistake = await page.evaluate(() => window.jiwei.mistakes.list().then((ms) => ms.find((m) => m.question.includes('一加一'))))
    expect(mistake?.question).toContain('相加是二')
    await block().getByRole('button', { name: '全部存为练习笔记', exact: true }).click()
    await block().getByTestId('ui-confirm').getByRole('button', { name: '确认', exact: true }).click()
    await expect(page.getByPlaceholder('笔记标题')).toHaveValue('组件三题练习')
    const id = await page.evaluate(() => window.jiwei.notes.list({ search: '组件三题练习' }).then((ns) => ns[0].id))
    await expect
      .poll(() =>
        page.evaluate(
          (id) => window.jiwei.notes.blocks(id).then((bs) => new Set(bs.filter((b) => b.section === 'cue').map((b) => b.rowId)).size),
          id
        )
      )
      .toBe(3)
    await navTo(page, /AI 对话/)
  })
  test('卡片空格翻面，经确认存成康奈尔行并进入复习', async () => {
    await ask(
      '翻面练习',
      fence({
        type: 'flashcards',
        title: '组件复习卡片',
        cards: [
          { front: '什么是提取练习？', back: '主动回忆知识。' },
          { front: '什么是间隔重复？', back: '按间隔复习。' }
        ]
      })
    )
    await done()
    const card = block().getByRole('button', { name: '翻面', exact: true })
    await expect(card).toBeVisible()
    await card.focus()
    await page.keyboard.press('Space')
    await expect(block()).toContainText('主动回忆知识。')
    const before = await page.evaluate(() => window.jiwei.review.list('all').then((cs) => cs.length))
    await block().getByRole('button', { name: '加入复习', exact: true }).click()
    await block().getByTestId('ui-confirm').getByRole('button', { name: '确认', exact: true }).click()
    await expect(page.getByPlaceholder('笔记标题')).toHaveValue('组件复习卡片')
    await expect.poll(() => page.evaluate(() => window.jiwei.review.list('all').then((cs) => cs.length))).toBe(before + 2)
    await navTo(page, /AI 对话/)
  })
  test('填空逐空核对，并确认加入复习', async () => {
    await ask(
      '填空练习',
      fence({ type: 'cloze', title: '组件填空练习', text: '地球绕{{太阳}}公转，月球绕{{地球}}公转。', explain: '卫星与行星关系。' })
    )
    await done()
    await expect(block().getByRole('textbox')).toHaveCount(2)
    await block().getByRole('textbox').nth(0).fill('太阳')
    await block().getByRole('textbox').nth(1).fill('太阳')
    await block().getByRole('button', { name: '核对', exact: true }).click()
    await expect(block().getByText('正确', { exact: true })).toBeVisible()
    await expect(block().getByText('不正确', { exact: true })).toBeVisible()
    await block().getByRole('button', { name: '加入复习', exact: true }).click()
    await block().getByTestId('ui-confirm').getByRole('button', { name: '确认', exact: true }).click()
    await expect(page.getByPlaceholder('笔记标题')).toHaveValue('组件填空练习')
    const id = await page.evaluate(() => window.jiwei.notes.list({ search: '组件填空练习' }).then((ns) => ns[0].id))
    await expect.poll(() => page.evaluate((id) => window.jiwei.review.forNote(id).then((cs) => cs.length), id)).toBe(1)
    await navTo(page, /AI 对话/)
  })
  test('多选经确定回复，大组件换呈现只发送类型和标题', async () => {
    await ask(
      '多选方向',
      fence({
        type: 'choice',
        multi: true,
        question: '选哪些？',
        options: [
          { label: '方法甲', value: 'a' },
          { label: '方法乙', value: 'b' }
        ]
      })
    )
    await done()
    await block().getByRole('checkbox', { name: '方法甲', exact: true }).check()
    await block().getByRole('checkbox', { name: '方法乙', exact: true }).check()
    await expect(block().getByRole('button', { name: '确定', exact: true })).toBeVisible()
    answer = '收到操作'
    await block().getByRole('button', { name: '确定', exact: true }).click()
    await replied('choose')
    expect(lastUser()).toContain('方法甲、方法乙')
    expect(lastUser()).toContain('"values":["a","b"]')
    const large = {
      type: 'table', title: '大表', columns: [{ key: 'text', label: '内容' }],
      rows: Array.from({ length: 12 }, () => ({ text: '汉'.repeat(225) }))
    }
    expect(new TextEncoder().encode(JSON.stringify({ type: 'table', node: large })).length).toBeGreaterThan(8192)
    await ask('大组件换呈现', fence(large))
    await done()
    answer = '收到操作'
    await block().getByRole('button', { name: '组件菜单' }).click()
    await block().getByRole('menuitem', { name: '换一种呈现', exact: true }).click()
    await replied('restyle')
    expect(lastUser()).toContain('{"type":"table","title":"大表"}')
    expect(lastUser()).not.toContain('"node"')
  })
  test('就地答复的最新选项能回到原对话，侧栏也携带事件', async () => {
    await page.keyboard.press('ControlOrMeta+n')
    await page.getByPlaceholder('笔记标题').fill('P5 就地事件')
    await page.keyboard.press('Enter')
    await page.keyboard.type('术语需要解释。')
    answer = fence({
      type: 'choice',
      question: '要看哪个？',
      options: [
        { label: '继续解释', value: 'explain' },
        { label: '给出例子', value: 'example' }
      ]
    })
    await page.locator('.cornell-body p').first().click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.getByRole('button', { name: 'AI 修改', exact: true }).click()
    await page.getByRole('menuitem', { name: '解释', exact: true }).click()
    await done()
    answer = '收到操作'
    const dialog = page.getByRole('dialog', { name: '就地答复' })
    await dialog.getByRole('button', { name: '继续解释', exact: true }).click()
    await expect.poll(lastUser).toContain('action="choose"')
    await expect(dialog).toContainText('收到操作')
    expect(lastUser()).toContain('"value":"explain"')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await navTo(page, /今日/)
    await page.keyboard.press('ControlOrMeta+j')
    const panel = page.getByRole('complementary', { name: '积微助手', exact: true })
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('button', { name: '模型', exact: true })).toContainText('test-ui')
    answer = fence({
      type: 'choice',
      question: '侧栏问题',
      options: [
        { label: '侧栏继续', value: 'continue' },
        { label: '侧栏停止', value: 'stop' }
      ]
    })
    await panel.getByRole('textbox').fill('侧栏询问')
    await panel.getByRole('textbox').press('Enter')
    await expect(panel.getByTestId('ui-block').last()).toHaveAttribute('data-ui-state', 'ready')
    answer = '收到操作'
    await panel.getByRole('button', { name: '侧栏继续', exact: true }).click()
    await expect.poll(lastUser).toContain('action="choose"')
    await expect(panel).toContainText('收到操作')
    expect(lastUser()).toContain('"value":"continue"')
    await navTo(page, /AI 对话/)
  })
  test('练习提案成功后状态落盘失败，重试沿用同一笔记', async () => {
    await ask(
      '保存失败重试',
      fence({ type: 'flashcards', title: '保存重试练习', cards: [{ front: '什么是原子事实？', back: '单一可核对的陈述。' }] })
    )
    await done()
    await app.evaluate(({ ipcMain }) => {
      const channel = 'ui:saveState'
      const old = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown> }
      )._invokeHandlers.get(channel)!
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (event, ...args) => {
        if ((args[2] as { practiceNote?: unknown })?.practiceNote) throw new Error('受控落盘失败')
        return old(event, ...args)
      })
      ;(globalThis as unknown as { restoreUiState: () => void }).restoreUiState = () => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, old)
      }
    })
    await block().getByRole('button', { name: '加入复习', exact: true }).click()
    const panel = block().getByTestId('ui-confirm')
    await panel.getByRole('button', { name: '确认', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('受控落盘失败')
    expect(await page.evaluate(() => window.jiwei.notes.list({ search: '保存重试练习' }).then((ns) => ns.length))).toBe(1)
    await app.evaluate(() => (globalThis as unknown as { restoreUiState: () => void }).restoreUiState())
    await panel.getByRole('button', { name: '确认', exact: true }).click()
    await expect(page.getByPlaceholder('笔记标题')).toHaveValue('保存重试练习')
    expect(await page.evaluate(() => window.jiwei.notes.list({ search: '保存重试练习' }).then((ns) => ns.length))).toBe(1)
    const id = await page.evaluate(() => window.jiwei.notes.list({ search: '保存重试练习' }).then((ns) => ns[0].id))
    await expect.poll(() => page.evaluate((id) => window.jiwei.review.forNote(id).then((cs) => cs.length), id)).toBe(1)
    await navTo(page, /AI 对话/)
  })
})
