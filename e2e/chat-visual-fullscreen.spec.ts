import { test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedElectron } from './fixtures/isolateElectron'
import { navTo } from './fixtures/nav'
import { samples } from '../src/shared/ui/__tests__/fixtures'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page, server: Server, providerId: string
let answer = '',
  requests = 0
const userData = mkdtempSync(join(tmpdir(), 'jiwei-expanded-'))
const fence = (node: unknown): string => `\`\`\`jiwei-ui\n${JSON.stringify(node)}\n\`\`\``
const block = (): Locator => page.getByTestId('ui-block').last()
const expanded = (): Locator => page.getByTestId('expanded-surface')
async function selectCell(root: Locator): Promise<void> {
  const selectionRoot = root.locator('[data-expanded-reply]')
  await expect(selectionRoot).toHaveAttribute('data-reply-id', /.+/)
  await expect(selectionRoot).not.toHaveAttribute('data-streaming', 'true')
  const selected = await root
    .locator('tbody td')
    .first()
    .evaluate((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      return selection.toString()
    })
  expect(selected).not.toBe('')
}
const wideTable = {
  type: 'table',
  title: '完整六列表格',
  columns: Array.from({ length: 6 }, (_, i) => ({ key: `c${i}`, label: `列${i + 1}` })),
  rows: Array.from({ length: 40 }, (_, i) => Object.fromEntries(Array.from({ length: 6 }, (_, k) => [`c${k}`, `第${i + 1}行第${k + 1}列`])))
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET') {
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          '<!doctype html><title>受控浏览器共存</title><h1>放大期间原生网页应隐藏</h1><button id="native-action" onclick="this.textContent=\'原生交互已恢复\'">测试原生交互</button>'
        )
      return
    }
    let body = ''
    req.on('data', (part) => {
      body += part
    })
    req.on('end', () => {
      JSON.parse(body)
      requests++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const content = answer
      let offset = 0
      const timer = setInterval(() => {
        const finished = offset >= content.length
        res.write(
          `data: ${JSON.stringify({ id: 'expanded', object: 'chat.completion.chunk', created: 1, model: 'test-expanded', choices: [{ index: 0, delta: finished ? {} : { content: content.slice(offset, offset + 15) }, finish_reason: finished ? 'stop' : null }] })}\n\n`
        )
        offset += 15
        if (finished) {
          clearInterval(timer)
          res.end('data: [DONE]\n\n')
        }
      }, 5)
      res.on('close', () => clearInterval(timer))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  app = await isolatedElectron.launch({
    args: ['.', `--user-data-dir=${userData}`],
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
      const provider = await window.jiwei.providers.save({ kind: 'ollama', name: '受控放大验证', baseUrl, models: ['test-expanded'] })
      const settings = await window.jiwei.settings.get()
      await window.jiwei.settings.set({
        ai: {
          ...settings.ai,
          chat: { providerId: provider.id, model: 'test-expanded' },
          effort: 'off',
          ui: { ...settings.ai.ui, localModels: 'normal', inline: true }
        }
      })
      return provider.id
    },
    `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  )
  await navTo(page, /AI 对话/)
})
test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
})

async function startAnswer(response: string): Promise<void> {
  answer = response
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await page.evaluate(async (id) => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...s.ai, chat: { providerId: id, model: 'test-expanded' } } })
  }, providerId)
  const input = page.getByRole('textbox').last()
  await input.fill('请展示本次受控验证内容')
  await input.press('Enter')
}
async function ask(response: string): Promise<void> {
  await startAnswer(response)
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0, { timeout: 20000 })
  await expect(page.locator('.chat-md').last()).toContainText(/./)
}

test('US1 图表放大实际扩大绘图区并保留同一图表', async () => {
  await ask(fence({ ...samples.chart, title: '放大图表' }))
  await expect(block().locator('.chart-canvas svg')).toBeVisible()
  const chart = await block().locator('.chart-canvas').elementHandle()
  const identity = await chart!.getAttribute('_echarts_instance_')
  for (const [width, height] of [
    [1280, 800],
    [1440, 900]
  ]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height])
    await block().getByRole('button', { name: '放大', exact: true }).click()
    await expect(expanded()).toBeVisible()
    await expect.poll(async () => (await expanded().locator('.chart-canvas').boundingBox())!.height).toBeGreaterThan(300)
    await expect.poll(async () => (await expanded().locator('.chart-canvas svg').boundingBox())!.height).toBeGreaterThan(300)
    expect(await chart!.getAttribute('_echarts_instance_')).toBe(identity)
    expect(await chart!.evaluate((el) => el.isConnected)).toBe(true)
    await expanded().getByRole('button', { name: '退出放大', exact: true }).click()
    await expect(expanded()).toHaveCount(0)
    await expect.poll(async () => (await block().locator('.chart-canvas').boundingBox())!.height).toBe(300)
  }
  expect(requests).toBeGreaterThan(0)
})

test('US1 二十四类根块共用放大入口且组合不创建子块按钮', async () => {
  test.setTimeout(180000)
  for (const [type, sample] of Object.entries(samples)) {
    await test.step(type, async () => {
      await ask(fence({ ...sample, title: `目录 ${type}` }))
      await expect(block()).toHaveAttribute('data-ui-state', 'ready')
      await expect(block().getByRole('button', { name: '放大', exact: true })).toHaveCount(1)
      await block().getByRole('button', { name: '放大', exact: true }).click()
      await expect(expanded()).toBeVisible()
      await expanded().getByRole('button', { name: '退出放大', exact: true }).click()
      await expect(expanded()).toHaveCount(0)
    })
  }
})

test('US1 普通 Mermaid 放大使用自然尺寸和同一 SVG', async () => {
  await ask('```mermaid\nflowchart LR\n' + Array.from({ length: 15 }, (_, i) => `N${i}[步骤${i}]-->N${i + 1}`).join('\n') + '\n```')
  const svg = page.locator('.diagram-svg svg').last()
  await expect(svg).toBeVisible()
  const handle = await svg.elementHandle()
  await page.getByRole('button', { name: '放大', exact: true }).last().click()
  await expect(expanded()).toBeVisible()
  expect(await handle!.evaluate((el) => el.isConnected)).toBe(true)
  expect(
    await expanded()
      .locator('.diagram-svg')
      .evaluate((el) => el.scrollWidth > el.clientWidth)
  ).toBe(true)
  await page.keyboard.press('Escape')
  await expect(expanded()).toHaveCount(0)
  expect(await handle!.evaluate((el) => el.isConnected)).toBe(true)
})

test('US1 就地问答和助手侧栏放大后解除四列限制，缩回恢复', async () => {
  await navTo(page, /笔记/)
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('放大就地问答')
  await page.keyboard.press('Enter')
  await page.keyboard.type('需要解释的正文，用于查看宽表。')
  answer = fence(wideTable)
  await page.locator('.cornell-body p').first().click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.getByRole('button', { name: 'AI 修改', exact: true }).click()
  await page.getByRole('menuitem', { name: '解释', exact: true }).click()
  const card = page.getByRole('dialog', { name: '就地答复' })
  await expect(card.getByRole('columnheader')).toHaveCount(4)
  await card.getByRole('button', { name: '放大', exact: true }).click()
  await expect(expanded().getByRole('columnheader')).toHaveCount(6)
  await expanded().getByRole('button', { name: '退出放大', exact: true }).click()
  await expect(card.getByRole('columnheader')).toHaveCount(4)
  await card.getByRole('button', { name: '关闭', exact: true }).click()
  await navTo(page, /今日/)
  await page.keyboard.press('ControlOrMeta+j')
  const panel = page.getByRole('complementary', { name: '积微助手', exact: true })
  await panel.getByRole('textbox').fill('侧栏宽表')
  await panel.getByRole('textbox').press('Enter')
  await expect(panel.getByRole('columnheader')).toHaveCount(4)
  await panel.getByRole('button', { name: '放大', exact: true }).last().click()
  await expect(expanded().getByRole('columnheader')).toHaveCount(6)
  await expanded().getByRole('button', { name: '退出放大', exact: true }).click()
  await expect(panel.getByRole('columnheader')).toHaveCount(4)
  await page.keyboard.press('ControlOrMeta+j')
  await navTo(page, /AI 对话/)
})

test('US2 排序、表单、计算器、标签、翻面和本地代码步骤三次进出保持', async () => {
  test.setTimeout(90000)
  const cases = [
    {
      node: { ...wideTable, editable: true },
      prepare: async () => {
        await block().getByRole('button', { name: '列1', exact: true }).click()
        await block()
          .locator('.ui-table-scroll')
          .evaluate((el) => {
            el.scrollTop = 150
          })
      },
      check: async () => {
        await expect(block().getByRole('columnheader').first()).toHaveAttribute('aria-sort', 'ascending')
      }
    },
    {
      node: samples.form,
      prepare: async () => {
        await block().getByRole('spinbutton', { name: '时数' }).fill('7')
      },
      check: async () => {
        await expect(block().getByRole('spinbutton', { name: '时数' })).toHaveValue('7')
      }
    },
    {
      node: samples.calc,
      prepare: async () => {
        await block().getByRole('slider').focus()
        await page.keyboard.press('End')
      },
      check: async () => {
        await expect(block().getByRole('slider')).toHaveValue('10')
        await expect(block().getByTestId('ui-calc-output')).toHaveText('20.00')
      }
    },
    {
      node: samples.tabs,
      prepare: async () => {
        await block().getByRole('tab', { name: '乙' }).click()
      },
      check: async () => {
        await expect(block().getByRole('tab', { name: '乙' })).toHaveAttribute('aria-selected', 'true')
      }
    },
    {
      node: samples.flashcards,
      prepare: async () => {
        await block().getByRole('button', { name: '翻面', exact: true }).click()
      },
      check: async () => {
        await expect(block().getByRole('button', { name: '翻面', exact: true })).toHaveText('答案')
      }
    },
    {
      node: {
        ...samples.codesteps,
        code: 'const x = 1\nconst y = 2',
        steps: [
          { lines: [1], note: '第一步' },
          { lines: [2], note: '第二步' }
        ]
      },
      prepare: async () => {
        await block().getByRole('button', { name: '下一步', exact: true }).click()
      },
      check: async () => {
        await expect(block()).toContainText('第二步')
      }
    }
  ]
  for (const item of cases) {
    await test.step(item.node.type, async () => {
      await ask(fence(item.node))
      await expect(block()).toHaveAttribute('data-ui-state', 'ready')
      await app.evaluate(({ ipcMain }) => {
        type Handler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
        const counts: Record<string, number> = {}
        const originals = new Map<string, Handler>()
        for (const channel of ['ui:saveState', 'ui:saveToNote', 'ui:canShareDerived', 'actions:create', 'plan:eventSave']) {
          const original = handlers.get(channel)
          if (!original) continue
          originals.set(channel, original)
          counts[channel] = 0
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, (event, ...args) => {
            counts[channel]++
            return original(event, ...args)
          })
        }
        ;(globalThis as unknown as { expandedProbe: { counts: Record<string, number>; restore(): void } }).expandedProbe = {
          counts,
          restore() {
            for (const [channel, original] of originals) {
              ipcMain.removeHandler(channel)
              ipcMain.handle(channel, original)
            }
          }
        }
      })
      await item.prepare()
      await item.check()
      if (item.node.type !== 'codesteps')
        await expect
          .poll(() =>
            app.evaluate(
              () => (globalThis as unknown as { expandedProbe: { counts: Record<string, number> } }).expandedProbe.counts['ui:saveState']
            )
          )
          .toBeGreaterThan(0)
      const ipcBaseline = await app.evaluate(() => ({
        ...(globalThis as unknown as { expandedProbe: { counts: Record<string, number> } }).expandedProbe.counts
      }))
      const element = await block().elementHandle()
      const calls = requests
      for (let i = 0; i < 3; i++) {
        await block().getByRole('button', { name: '放大', exact: true }).click()
        await expect(expanded()).toBeVisible()
        await item.check()
        await expanded().getByRole('button', { name: '退出放大', exact: true }).click()
        await expect(expanded()).toHaveCount(0)
        await item.check()
        expect(await element!.evaluate((el) => el.isConnected)).toBe(true)
        await expect(block().getByRole('button', { name: '放大', exact: true })).toBeFocused()
      }
      expect(requests).toBe(calls)
      expect(
        await app.evaluate(() => ({
          ...(globalThis as unknown as { expandedProbe: { counts: Record<string, number> } }).expandedProbe.counts
        }))
      ).toEqual(ipcBaseline)
      await app.evaluate(() => (globalThis as unknown as { expandedProbe: { restore(): void } }).expandedProbe.restore())
      if (item.node.type === 'table')
        await expect
          .poll(() =>
            block()
              .locator('.ui-table-scroll')
              .evaluate((el) => el.scrollTop)
          )
          .toBe(150)
    })
  }
})

test('US2 助手放大中的同一笔记导航退出且目标继续可见', async () => {
  await navTo(page, /笔记/)
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('放大导航目标')
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '放大导航目标' }).then((notes) => notes.length))).toBe(1)
  const note = await page.evaluate(async () => (await window.jiwei.notes.list({ search: '放大导航目标' }))[0])
  answer = fence({ type: 'note', noteId: note.id })
  await page.keyboard.press('ControlOrMeta+j')
  const panel = page.getByRole('complementary', { name: '积微助手', exact: true })
  await panel.getByRole('textbox').fill('打开当前笔记')
  await panel.getByRole('textbox').press('Enter')
  await expect(panel.getByTestId('ui-block').getByRole('button', { name: '放大导航目标', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '放大', exact: true }).click()
  await expanded().getByRole('button', { name: '放大导航目标', exact: true }).click()
  await expect(expanded()).toHaveCount(0)
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('放大导航目标')
  await page.keyboard.press('ControlOrMeta+j')
  await navTo(page, /AI 对话/)
})

test('US2 键盘打开、焦点循环和 Escape 只退出就地放大', async () => {
  await ask(fence(samples.form))
  await block().getByRole('spinbutton', { name: '时数' }).fill('3')
  const toggle = block().getByRole('button', { name: '放大', exact: true })
  await toggle.focus()
  await page.keyboard.press('Space')
  const exit = expanded().getByRole('button', { name: '退出放大', exact: true })
  const submit = expanded().getByRole('button', { name: '提交', exact: true })
  await expect(exit).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(submit).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(exit).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(toggle).toBeFocused()

  await navTo(page, /笔记/)
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('Escape 保留问答')
  await page.keyboard.press('Enter')
  await page.keyboard.type('用于就地回答的正文。')
  answer = fence(wideTable)
  await page.locator('.cornell-body p').first().click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.getByRole('button', { name: 'AI 修改', exact: true }).click()
  await page.getByRole('menuitem', { name: '解释', exact: true }).click()
  const card = page.getByRole('dialog', { name: '就地答复' })
  await card.getByRole('button', { name: '放大', exact: true }).click()
  await selectCell(expanded())
  const toolbar = expanded().getByRole('toolbar', { name: '选区操作' })
  await expect(toolbar.getByRole('button', { name: '复制', exact: true })).toBeVisible()
  await expect(toolbar.getByRole('button', { name: '解释', exact: true })).toHaveCount(0)
  await toolbar.getByRole('button', { name: '复制', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(expanded()).toHaveCount(0)
  await expect(card).toBeVisible()
  await card.getByRole('button', { name: '关闭', exact: true }).click()
  await navTo(page, /AI 对话/)
})

test('US2 放大中的新滚动位置退出后仍保留', async () => {
  await ask(fence(wideTable))
  await block()
    .locator('.ui-table-scroll')
    .evaluate((el) => {
      el.scrollTop = 150
    })
  await block().getByRole('button', { name: '放大', exact: true }).click()
  await expanded()
    .locator('.ui-table-scroll')
    .evaluate((el) => {
      el.scrollTop = 210
    })
  await expanded().getByRole('button', { name: '退出放大', exact: true }).click()
  await expect
    .poll(() =>
      block()
        .locator('.ui-table-scroll')
        .evaluate((el) => el.scrollTop)
    )
    .toBe(210)
})

test('US2 非底部的对话阅读位置和占位在退出后恢复', async () => {
  const paragraphs = Array.from({ length: 18 }, (_, i) => `阅读定位段落 ${i}：在长回答中保留当前阅读位置。`).join('\n\n')
  await ask(paragraphs + '\n\n' + fence(samples.calc) + '\n\n' + paragraphs)
  const reader = await block().evaluateHandle((el) => {
    let parent = el.parentElement!
    while (parent && !(parent.scrollHeight > parent.clientHeight && getComputedStyle(parent).overflowY === 'auto'))
      parent = parent.parentElement!
    parent.scrollTop += el.getBoundingClientRect().top - parent.getBoundingClientRect().top - 60
    return parent
  })
  const top = await reader.evaluate((el) => Math.round(el.scrollTop))
  expect(top).toBeGreaterThan(100)
  expect(await reader.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(100)
  const position = await block().boundingBox()
  for (let i = 0; i < 3; i++) {
    await block().getByRole('button', { name: '放大', exact: true }).click()
    await expanded().getByRole('button', { name: '退出放大', exact: true }).click()
    await expect.poll(() => reader.evaluate((el) => Math.round(el.scrollTop))).toBe(top)
    expect(Math.round((await block().boundingBox())!.y)).toBe(Math.round(position!.y))
  }
})

test('US2 放大中发送选择只生成一次后续回复', async () => {
  await ask(fence(samples.choice))
  const before = requests
  answer = '已收到你的选择，这是后续回复。'
  await block().getByRole('button', { name: '放大', exact: true }).click()
  await expanded().getByRole('button', { name: '甲', exact: true }).click()
  await expect(expanded()).toHaveCount(0)
  await expect(page.locator('.chat-md').last()).toContainText('这是后续回复。')
  expect(requests).toBe(before + 1)
})

test('US2 放大中的文字选区保留引用追问并退出到原会话', async () => {
  await ask(fence(wideTable))
  await block().getByRole('button', { name: '放大', exact: true }).click()
  await selectCell(expanded())
  const toolbar = expanded().getByRole('toolbar', { name: '选区操作' })
  await expect(toolbar.getByRole('button', { name: '解释', exact: true })).toBeVisible()
  await toolbar.getByRole('button', { name: '引用追问', exact: true }).click()
  await expect(expanded()).toHaveCount(0)
  await expect(page.getByTestId('reply-quote')).toContainText('第1行第1列')
  await expect(page.getByRole('textbox').last()).toBeFocused()
})

test('US2 放大内复制、导出及保存取消和失败重试沿用原路径', async () => {
  await ask(fence({ ...samples.chart, title: '放大保存图表' }))
  await expect(block().locator('.chart-canvas svg')).toBeVisible()
  await block().getByRole('button', { name: '放大', exact: true }).click()
  const menu = async (name: string): Promise<void> => {
    await expanded().getByRole('button', { name: '组件菜单' }).click()
    await expanded().getByRole('menuitem', { name, exact: true }).click()
  }
  await menu('复制为 Markdown')
  await expect.poll(() => app.evaluate(async ({ clipboard }) => (await clipboard.readText()).includes('放大保存图表'))).toBe(true)
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-expanded-svg-'))
  await app.evaluate(({ BrowserWindow }, dir) => {
    BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
      item.setSavePath(dir + '/' + item.getFilename())
    })
  }, dir)
  await menu('导出图片')
  await expect.poll(() => readdirSync(dir).filter((name) => name.endsWith('.svg')).length).toBe(1)
  expect(
    readFileSync(
      join(
        dir,
        readdirSync(dir).find((name) => name.endsWith('.svg'))!
      ),
      'utf8'
    )
  ).toContain('<svg')
  await menu('存进笔记')
  await expanded().getByTestId('ui-save-target').getByRole('button', { name: '新建笔记', exact: true }).click()
  await expanded().getByTestId('ui-confirm').getByRole('button', { name: '取消', exact: true }).click()
  expect(await page.evaluate(() => window.jiwei.notes.list({ search: '放大保存图表' }).then((notes) => notes.length))).toBe(0)
  await menu('存进笔记')
  await expanded().getByTestId('ui-save-target').getByRole('button', { name: '新建笔记', exact: true }).click()
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
    const original = handlers.get('ui:saveToNote')!
    let fail = true
    ipcMain.removeHandler('ui:saveToNote')
    ipcMain.handle('ui:saveToNote', (...args) => {
      if (fail) {
        fail = false
        throw new Error('受控保存失败')
      }
      return original(...args)
    })
    ;(globalThis as unknown as { restoreExpandedSave(): void }).restoreExpandedSave = () => {
      ipcMain.removeHandler('ui:saveToNote')
      ipcMain.handle('ui:saveToNote', original)
    }
  })
  try {
    const confirm = expanded().getByTestId('ui-confirm')
    await confirm.getByRole('button', { name: '确认', exact: true }).click()
    await expect(confirm.getByRole('alert')).toContainText('受控保存失败')
    await expect(expanded()).toBeVisible()
    await confirm.getByRole('button', { name: '确认', exact: true }).click()
    await expect(expanded()).toHaveCount(0)
    await expect(page.getByPlaceholder('笔记标题')).toHaveValue('放大保存图表')
    await expect(page.locator('.embed-block[data-kind="chart"] .chart-canvas svg')).toBeVisible()
    expect(await page.evaluate(() => window.jiwei.notes.list({ search: '放大保存图表' }).then((notes) => notes.length))).toBe(1)
  } finally {
    await app.evaluate(() => (globalThis as unknown as { restoreExpandedSave(): void }).restoreExpandedSave())
  }
  await navTo(page, /AI 对话/)
})

test('US3 错误、超限和转文字无入口，展示失效自动退出', async () => {
  for (const invalid of [
    '```jiwei-ui\n{broken}\n```',
    fence({ type: 'unknown' }),
    fence({ type: 'diagram', code: 'not a diagram' }),
    '```mermaid\nnot a diagram\n```'
  ]) {
    await ask(invalid)
    await expect(page.getByRole('button', { name: '放大', exact: true })).toHaveCount(0)
  }
  await ask(Array.from({ length: 4 }, (_, i) => fence({ ...samples.list, title: `根块${i}` })).join('\n\n'))
  await expect(page.getByTestId('ui-block')).toHaveCount(4)
  await expect(page.getByRole('button', { name: '放大', exact: true })).toHaveCount(3)
  await expect(block().getByRole('button', { name: '放大', exact: true })).toHaveCount(0)
  await ask(fence(samples.table))
  await block().getByRole('button', { name: '放大', exact: true }).click()
  await expanded().getByRole('button', { name: '组件菜单' }).click()
  await expanded().getByRole('menuitem', { name: '改成文字', exact: true }).click()
  await expect(expanded()).toHaveCount(0)
  await expect(block()).toHaveAttribute('data-ui-display', 'text')
  await expect(block().getByRole('button', { name: '放大', exact: true })).toHaveCount(0)
  await expect.poll(() => page.locator('body').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('auto')
  await expect(page.locator('.expanded-anchor').last()).toBeFocused()
})

test('US3 未闭合停止无入口，完整停止和旧消息只读可放大', async () => {
  await startAnswer(fence(wideTable))
  await expect(block()).toHaveAttribute('data-ui-state', 'streaming')
  await expect(block().getByRole('button', { name: '放大', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(block().getByRole('button', { name: '放大', exact: true })).toHaveCount(0)
  await startAnswer(fence(samples.choice) + '\n\n' + '继续生成说明。'.repeat(1600))
  await expect(block()).toHaveAttribute('data-ui-state', 'ready')
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await block().getByRole('button', { name: '放大', exact: true }).click()
  await expect(expanded().getByRole('button', { name: '甲', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await ask(fence(samples.choice))
  answer = '下一轮完整回复。'
  await page.getByRole('textbox').last().fill('下一轮')
  await page.getByRole('textbox').last().press('Enter')
  await expect(page.locator('.chat-md').last()).toContainText('下一轮完整回复。')
  await block().getByRole('button', { name: '放大', exact: true }).click()
  await expect(expanded().getByRole('button', { name: '甲', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
})

test('US3 菜单和顶层对话框逐层 Escape，重复打开与卸载无残留', async () => {
  await ask(fence(samples.calc))
  await block()
    .getByRole('button', { name: '放大', exact: true })
    .evaluate((el: HTMLButtonElement) => {
      el.click()
      el.click()
    })
  await expect(expanded()).toHaveCount(1)
  await expanded().getByRole('button', { name: '组件菜单' }).click()
  await page.keyboard.press('Escape')
  await expect(expanded()).toBeVisible()
  await expect(expanded().getByRole('menu')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+,')
  const settings = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'AI 模型', exact: true }) })
  await expect(settings).toBeVisible()
  expect(
    await settings.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    })
  ).toBe(true)
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(expanded()).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640))
  const exit = expanded().getByRole('button', { name: '退出放大', exact: true })
  await expect(exit).toBeInViewport()
  const rect = await exit.boundingBox()
  expect(rect!.y).toBeGreaterThanOrEqual(44)
  await page.keyboard.press('ControlOrMeta+n')
  await expect(expanded()).toHaveCount(0)
  await expect(page.locator('.expanded-mount[data-display-mode="expanded"]')).toHaveCount(0)
  await expect.poll(() => page.locator('body').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('auto')
  await page.getByRole('textbox').last().fill('卸载后仍可输入')
  await expect(page.getByRole('textbox').last()).toHaveValue('卸载后仍可输入')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
})

test('US3 打开移动失败恢复原内容，恢复后可再次放大', async () => {
  await ask(fence(samples.calc))
  const original = await block().elementHandle()
  await page.evaluate(() => {
    const append = Element.prototype.appendChild
    ;(window as unknown as { restoreExpandedAppend(): void }).restoreExpandedAppend = () => {
      Element.prototype.appendChild = append
    }
    Element.prototype.appendChild = function <T extends Node>(node: T): T {
      if (this instanceof HTMLElement && this.classList.contains('expanded-slot')) throw new Error('受控移动失败')
      return append.call(this, node) as T
    }
  })
  try {
    await block().getByRole('button', { name: '放大', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('无法放大')
    await expect(expanded()).toHaveCount(0)
    expect(await original!.evaluate((el) => el.isConnected)).toBe(true)
    await expect(block().getByRole('slider')).toBeEnabled()
    await expect(block().getByRole('button', { name: '放大', exact: true })).toBeFocused()
    await expect.poll(() => page.locator('body').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('auto')
  } finally {
    await page.evaluate(() => (window as unknown as { restoreExpandedAppend(): void }).restoreExpandedAppend())
  }
  await block().getByRole('button', { name: '放大', exact: true }).click()
  await expect(expanded()).toBeVisible()
  await page.keyboard.press('Escape')
})

test('US3 内置浏览器冻结原生视图，退出后恢复真实网页交互', async () => {
  await navTo(page, /^浏览/)
  await page
    .getByTestId('browser-start')
    .getByRole('textbox')
    .fill(`http://127.0.0.1:${(server.address() as { port: number }).port}/fullscreen-site`)
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => window.jiwei.browser.state().then((s) => s.tabs[0]?.title))).toBe('受控浏览器共存')
  await page.keyboard.press('ControlOrMeta+j')
  const panel = page.getByRole('complementary', { name: '积微助手', exact: true })
  answer = fence({ ...samples.chart, title: '网页旁放大图' })
  await panel.getByRole('textbox').fill('显示图表')
  await panel.getByRole('textbox').press('Enter')
  await panel.getByRole('button', { name: '放大', exact: true }).last().click()
  await expect(page.getByTestId('browser-view').locator('img')).toBeVisible()
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.some((view) => view.getVisible()))
    )
    .toBe(false)
  await expanded().getByRole('button', { name: '退出放大', exact: true }).click()
  await expect(page.getByTestId('browser-view').locator('img')).toHaveCount(0)
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.some((view) => view.getVisible()))
    )
    .toBe(true)
  const nativePage = (await app.context().pages()).find((p) => p.url().includes('/fullscreen-site'))!
  await nativePage.locator('#native-action').click()
  await expect(nativePage.locator('#native-action')).toHaveText('原生交互已恢复')
  await page.keyboard.press('ControlOrMeta+j')
  await navTo(page, /AI 对话/)
})

test('US3 校验中与关闭紧凑组件设置不提供入口', async () => {
  await page.evaluate(() => {
    const validate = window.__jiweiValidate
    const release: (() => void)[] = []
    window.__jiweiValidate = (kind, data) =>
      new Promise((resolve) => {
        release.push(() => {
          void (validate?.(kind, data) ?? Promise.resolve(null)).then(resolve)
        })
      })
    ;(window as unknown as { releaseExpandedValidation(): void }).releaseExpandedValidation = () => {
      window.__jiweiValidate = validate
      release.forEach((done) => done())
    }
  })
  try {
    await ask(fence(samples.diagram))
    await expect(block()).toHaveAttribute('data-ui-state', 'ready')
    await expect(block().getByRole('button', { name: '放大', exact: true })).toHaveCount(0)
    await expect(block().locator('.diagram-svg svg')).toHaveCount(0)
  } finally {
    await page.evaluate(() => (window as unknown as { releaseExpandedValidation(): void }).releaseExpandedValidation())
  }
  await expect(block().getByRole('button', { name: '放大', exact: true })).toBeVisible()
  await navTo(page, /今日/)
  await page.keyboard.press('ControlOrMeta+j')
  const panel = page.getByRole('complementary', { name: '积微助手', exact: true })
  answer = fence(samples.calc)
  await panel.getByRole('textbox').fill('显示计算器')
  await panel.getByRole('textbox').press('Enter')
  await panel.getByRole('button', { name: '放大', exact: true }).last().click()
  await page.evaluate(async () => {
    const settings = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...settings.ai, ui: { ...settings.ai.ui, inline: false } } })
  })
  await expect(expanded()).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '放大', exact: true })).toHaveCount(0)
  await page.evaluate(async () => {
    const settings = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...settings.ai, ui: { ...settings.ai.ui, inline: true } } })
  })
  await page.keyboard.press('ControlOrMeta+j')
  await navTo(page, /AI 对话/)
})

test('US1 代表性视觉材料覆盖浅深主题和最小窗口', async () => {
  const variants = [
    {
      theme: 'light',
      width: 1000,
      height: 640,
      response:
        '```mermaid\nflowchart LR\n' + Array.from({ length: 15 }, (_, i) => `N${i}[可读步骤 ${i}]-->N${i + 1}`).join('\n') + '\n```',
      name: 'light-min-diagram'
    },
    {
      theme: 'dark',
      width: 1440,
      height: 900,
      response: fence({ type: 'columns', title: '图表与完整数据', children: [samples.chart, wideTable] }),
      name: 'dark-normal-columns'
    },
    { theme: 'light', width: 1440, height: 900, response: fence({ ...samples.chart, title: '   ' }), name: 'light-normal-chart' },
    { theme: 'dark', width: 1000, height: 640, response: fence(wideTable), name: 'dark-min-table' }
  ] as const
  for (const v of variants) {
    await page.evaluate((theme) => window.jiwei.settings.set({ theme }), v.theme)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
    await ask(v.response)
    await app.evaluate(({ BrowserWindow }, v) => BrowserWindow.getAllWindows()[0].setSize(v.width, v.height), v)
    await page.getByRole('button', { name: '放大', exact: true }).last().click()
    await expect(expanded().getByRole('button', { name: '退出放大', exact: true })).toBeInViewport()
    if (v.name === 'light-normal-chart') await expect(page.getByRole('dialog', { name: '交互内容', exact: true })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath(v.name + '.png') })
    await page.keyboard.press('Escape')
  }
  await page.evaluate(() => window.jiwei.settings.set({ theme: 'system' }))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
})
