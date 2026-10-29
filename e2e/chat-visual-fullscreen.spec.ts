import { test, expect, type ElectronApplication, type Page, type Locator } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedElectron } from './fixtures/isolateElectron'
import { navTo } from './fixtures/nav'
import { samples } from '../src/shared/ui/__tests__/fixtures'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page, server: Server, providerId: string
let answer = '',
  requests = 0
const requestLog: { at: number; url: string; system: string }[] = []
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
      const input = JSON.parse(body) as { messages?: { role: string; content: unknown }[] }
      requestLog.push({
        at: Date.now(),
        url: req.url ?? '',
        system: String(input.messages?.find((message) => message.role === 'system')?.content ?? '').slice(0, 100)
      })
      requests++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const content = answer
      let offset = 0
      const timer = setInterval(() => {
        const finished = offset >= content.length
        res.write(
          `data: ${JSON.stringify({ id: 'expanded', object: 'chat.completion.chunk', created: 1, model: 'test-expanded', choices: [{ index: 0, delta: finished ? {} : { content: content.slice(offset, offset + 15) }, finish_reason: finished ? 'stop' : null }], ...(finished ? { usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 } } : {}) })}\n\n`
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
  await app.evaluate(({ BrowserWindow }) => {
    const events = { close: 0, closed: 0, hide: 0 }
    const window = BrowserWindow.getAllWindows()[0]
    for (const name of ['close', 'closed', 'hide'] as const)
      window.on(name, () => {
        events[name]++
      })
    ;(globalThis as unknown as { fullscreenWindowEvents: typeof events }).fullscreenWindowEvents = events
  })
  providerId = await page.evaluate(
    async (baseUrl) => {
      const provider = await window.jiwei.providers.save({
        kind: 'ollama',
        name: '受控放大验证',
        baseUrl,
        models: ['test-expanded'],
        modelCaps: { 'test-expanded': { price: { currency: 'USD', input: 1, output: 1 } } }
      })
      const settings = await window.jiwei.settings.get()
      // Delayed memory extraction is independent of fullscreen and otherwise races
      // the strict zero-new-request assertion after this catalogue suite exceeds 2 minutes.
      await window.jiwei.memory.setSettings({ autoLearn: false, learnSkills: false })
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
test.afterEach(async () => {
  if (test.info().status !== test.info().expectedStatus)
    writeFileSync(test.info().outputPath('request-log.json'), JSON.stringify(requestLog, null, 2))
})

async function startAnswer(response: string): Promise<void> {
  answer = response
  await page.keyboard.press('ControlOrMeta+n')
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

async function expectCentered(viewport: Locator, content: Locator): Promise<void> {
  const center = await viewport.evaluate((el) => {
    const r = el.getBoundingClientRect(),
      s = getComputedStyle(el)
    const left = parseFloat(s.paddingLeft),
      right = parseFloat(s.paddingRight)
    const top = parseFloat(s.paddingTop),
      bottom = parseFloat(s.paddingBottom)
    return {
      x: r.x + el.clientLeft + left + (el.clientWidth - left - right) / 2,
      y: r.y + el.clientTop + top + (el.clientHeight - top - bottom) / 2
    }
  })
  const actual = await content.boundingBox()
  expect(actual).not.toBeNull()
  expect(Math.abs(actual!.x + actual!.width / 2 - center.x), '正文水平中心').toBeLessThanOrEqual(1)
  expect(Math.abs(actual!.y + actual!.height / 2 - center.y), '正文垂直中心').toBeLessThanOrEqual(1)
}

async function expectSafeAlignment(viewport: Locator, content: Locator): Promise<void> {
  const handle = await content.elementHandle()
  const metrics = await viewport.evaluate((el, child) => {
    const r = el.getBoundingClientRect(),
      c = child!.getBoundingClientRect(),
      s = getComputedStyle(el)
    const x = r.x + el.clientLeft + parseFloat(s.paddingLeft),
      y = r.y + el.clientTop + parseFloat(s.paddingTop)
    const width = el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)
    const height = el.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)
    const flow = [...child!.children]
      .map((node) => {
        const rect = node.getBoundingClientRect(),
          style = getComputedStyle(node)
        return { rect, style }
      })
      .filter(({ rect, style }) => rect.height > 0 && !['absolute', 'fixed'].includes(style.position))
    const flowHeight =
      Math.max(...flow.map(({ rect, style }) => rect.bottom + parseFloat(style.marginBottom))) -
      Math.min(...flow.map(({ rect, style }) => rect.top - parseFloat(style.marginTop)))
    return { x, y, width, height, content: c.toJSON(), flowHeight }
  }, handle)
  // An actual natural-height group must be accounted for by its visible flow children.
  expect(Math.abs(metrics.content.height - metrics.flowHeight)).toBeLessThanOrEqual(1)
  if (metrics.content.width <= metrics.width + 1)
    expect(Math.abs(metrics.content.x + metrics.content.width / 2 - metrics.x - metrics.width / 2)).toBeLessThanOrEqual(1)
  else expect(Math.abs(metrics.content.x - metrics.x)).toBeLessThanOrEqual(1)
  if (metrics.content.height <= metrics.height + 1)
    expect(Math.abs(metrics.content.y + metrics.content.height / 2 - metrics.y - metrics.height / 2)).toBeLessThanOrEqual(1)
  else {
    expect(Math.abs(metrics.content.y - metrics.y)).toBeLessThanOrEqual(1)
    await viewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    const end = await content.boundingBox(),
      box = await viewport.boundingBox()
    expect(end!.y + end!.height).toBeLessThanOrEqual(box!.y + box!.height + 1)
    await viewport.evaluate((el) => {
      el.scrollTop = 0
    })
  }
}

test('FIX shared short content centers in the actual body viewport', async () => {
  await ask(fence(samples.list))
  await block().getByRole('button', { name: '放大', exact: true }).click()
  await expectCentered(expanded().locator('.ui-frame-body'), expanded().locator('.ui-frame-body > div').first())
  await expanded().getByRole('button', { name: '退出放大', exact: true }).click()
})

test('FIX ordinary Markdown table has an opaque safe centered fullscreen', async () => {
  await ask('| 项目 | RNN / LSTM | Transformer |\n| --- | --- | --- |\n| 计算 | 按顺序计算 | 并行计算 |\n| 依赖 | 逐步传递 | 一步直达 |')
  await page.getByRole('button', { name: 'View fullscreen', exact: true }).last().click()
  const surface = page.locator('[data-streamdown="table-fullscreen"]')
  expect(await surface.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
  expect((await surface.boundingBox())!.y).toBeGreaterThanOrEqual(44)
  await expectCentered(surface.locator('div:has(> table)').last(), surface.locator('table'))
  await surface.getByRole('button', { name: 'Exit fullscreen', exact: true }).click()
  await expect(surface).toHaveCount(0)
})

test('FIX expanded chart data table cannot create a second fullscreen', async () => {
  await ask(fence(samples.chart))
  await expect(block().locator('.chart-canvas svg')).toBeVisible()
  await block().getByRole('button', { name: '放大', exact: true }).click()
  await expanded().locator('details > summary').first().click()
  await expect(expanded().getByRole('button', { name: 'View fullscreen', exact: true })).toHaveCount(0)
  await expect(expanded().getByRole('button', { name: 'Copy table', exact: true })).toBeVisible()
  await expect(expanded().getByRole('button', { name: 'Download table', exact: true })).toBeVisible()
  await expect(page.locator('[data-streamdown="table-fullscreen"]')).toHaveCount(0)
  await expanded().getByRole('button', { name: '退出放大', exact: true }).click()
  await expect(block().getByRole('button', { name: 'View fullscreen', exact: true })).toBeVisible()
})

test('FIX layout clamp does not overwrite the inline scroll position', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await ask(
    fence({ type: 'table', columns: [{ key: 'n', label: '内容' }], rows: Array.from({ length: 18 }, (_, i) => ({ n: `第${i}行` })) })
  )
  const scroll = block().locator('.ui-table-scroll')
  await scroll.evaluate((el) => {
    el.scrollTop = 80
  })
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(80)
  await block().getByRole('button', { name: '放大', exact: true }).click()
  expect(
    await expanded()
      .locator('.ui-table-scroll')
      .evaluate((el) => el.scrollHeight <= el.clientHeight + 1)
  ).toBe(true)
  await expanded().getByRole('button', { name: '退出放大', exact: true }).click()
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(80)
})

test('FIX all 24 types center real content in both themes and three windows', async () => {
  test.setTimeout(180000)
  await navTo(page, /笔记/)
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('居中验收的真实笔记')
  await page.keyboard.press('Enter')
  await page.keyboard.type('检查真实正文、交互状态和滚动位置。')
  await expect
    .poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '居中验收的真实笔记' }).then((notes) => notes.length)))
    .toBe(1)
  const noteId = await page.evaluate(async () => {
    const note = (await window.jiwei.notes.list({ search: '居中验收的真实笔记' }))[0]
    await window.jiwei.proposals.create({
      noteId: note.id,
      title: '居中验收正文',
      auto: true,
      ops: [
        {
          op: 'insert_row',
          afterRowId: null,
          cue: [{ type: 'paragraph', content: [{ type: 'text', text: '验收问题' }] }],
          body: [{ type: 'paragraph', content: [{ type: 'text', text: '检查真实正文、交互状态和滚动位置。' }] }]
        }
      ]
    })
    await window.jiwei.actions.create('布局验收行动项', null)
    return note.id
  })
  await expect.poll(() => page.evaluate((id) => window.jiwei.notes.blocks(id).then((rows) => rows.length), noteId)).toBeGreaterThan(0)
  const sourcePath = join(mkdtempSync(join(tmpdir(), 'jiwei-layout-source-')), '原文.md')
  writeFileSync(sourcePath, '# 居中验收原文\n\n有效原文供真实数据组件读取。')
  const sourceId = await page.evaluate(async (file) => (await window.jiwei.sources.importPaths([file])).imported[0].id, sourcePath)
  await expect.poll(() => page.evaluate((id) => window.jiwei.segments.list(id).then((rows) => rows.length), sourceId)).toBeGreaterThan(0)
  const segmentId = await page.evaluate((id) => window.jiwei.segments.list(id).then((rows) => rows[0].id), sourceId)
  const nodes: Record<string, unknown> = {
    ...samples,
    note: { type: 'note', noteId },
    excerpt: { type: 'excerpt', segmentId },
    mastery: { type: 'mastery', scope: { kind: 'note', id: noteId } },
    tasks: { type: 'tasks', filter: { scope: 'open' } },
    details: { ...samples.details, open: true }
  }
  await navTo(page, /AI 对话/)
  const metrics: unknown[] = []
  for (const [type, sample] of Object.entries(nodes)) {
    await ask(fence(sample))
    await expect(block()).toHaveAttribute('data-ui-state', 'ready')
    if (['note', 'excerpt', 'mastery', 'tasks', 'usage'].includes(type)) {
      await expect(block()).not.toContainText('正在读取…')
      await expect(block()).not.toContainText('已关闭数据访问')
    }
    if (type === 'note') await expect(block()).toContainText('检查真实正文')
    if (type === 'excerpt') await expect(block()).toContainText('有效原文')
    if (type === 'usage' || type === 'chart') await expect(block().locator('.chart-canvas svg')).toBeVisible()
    if (type === 'diagram') await expect(block().locator('.diagram-svg svg')).toBeVisible()
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
      }, theme)
      for (const [width, height] of [
        [1000, 640],
        [1280, 800],
        [1440, 900]
      ]) {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height])
        await block().getByRole('button', { name: '放大', exact: true }).click()
        const content = expanded().locator('.ui-frame-content')
        await expect(content).toBeVisible()
        expect((await expanded().getByRole('button', { name: '退出放大', exact: true }).boundingBox())!.y).toBeGreaterThanOrEqual(44)
        await expectSafeAlignment(expanded().locator('.ui-frame-body'), content)
        if (type === 'usage' || type === 'chart') {
          const canvas = expanded().locator('.chart-canvas')
          expect((await canvas.boundingBox())!.width).toBeGreaterThan(700)
          expect((await canvas.boundingBox())!.height).toBeGreaterThan(300)
          await expect(canvas.locator('svg')).toBeVisible()
        }
        if (type === 'diagram') await expectCentered(expanded().locator('.ui-frame-body'), expanded().locator('.diagram-svg svg'))
        metrics.push({ type, theme, width, height, content: await content.boundingBox() })
        if (width === 1000 && ['list', 'usage', 'diagram', 'form', 'table'].includes(type))
          await expanded().screenshot({ path: test.info().outputPath(`${type}-${theme}.png`) })
        await expanded().getByRole('button', { name: '退出放大', exact: true }).click()
      }
    }
  }
  writeFileSync(test.info().outputPath('layout-matrix.json'), JSON.stringify(metrics, null, 2))
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })
})

test('FIX visible composition stays grouped when switching and collapsing', async () => {
  const tabNode = {
    type: 'tabs',
    note: '组合说明随正文一起居中',
    tabs: [
      { label: '宽图', children: [{ ...samples.chart, cite: 1 }, samples.form] },
      { label: '短选项', children: [samples.choice] }
    ]
  }
  await ask(fence(tabNode))
  await block().getByRole('button', { name: '放大', exact: true }).click()
  await expect(expanded().locator('.ui-visible-group')).toContainText('[1]')
  await expect(expanded().locator('.ui-frame-content')).toContainText('组合说明随正文一起居中')
  await expectSafeAlignment(expanded().locator('.ui-frame-body'), expanded().locator('.ui-frame-content'))
  await expanded().getByRole('tab', { name: '短选项', exact: true }).click()
  await expectCentered(expanded().getByRole('tabpanel'), expanded().locator('[data-layout-type="choice"]'))
  await expanded().getByRole('button', { name: '退出放大', exact: true }).click()
  await ask(fence({ type: 'details', summary: '含宽图的折叠区', children: [samples.chart] }))
  await block().getByRole('button', { name: '放大', exact: true }).click()
  const summary = expanded().getByText('含宽图的折叠区', { exact: true })
  await expectCentered(expanded().locator('.ui-frame-body'), summary)
  await summary.click()
  await expect(expanded().locator('.chart-canvas svg')).toBeVisible()
  await expectCentered(expanded().locator('.ui-frame-body'), expanded().locator('.ui-frame-content'))
  await expanded().getByRole('button', { name: '退出放大', exact: true }).click()
})

test('FIX ordinary tables preserve both-axis reachability and real copy/download', async () => {
  test.setTimeout(90000)
  for (const [columns, rows] of [
    [3, 3],
    [20, 3],
    [3, 60],
    [20, 60]
  ]) {
    const headers = Array.from({ length: columns }, (_, i) => `Column${String(i + 1).padStart(2, '0')}-LongHeading`)
    const markdown = [
      '| ' + headers.join(' | ') + ' |',
      '| ' + headers.map(() => '---').join(' | ') + ' |',
      ...Array.from({ length: rows }, (_, r) => '| ' + headers.map((_, c) => `R${r + 1}-C${c + 1}`).join(' | ') + ' |')
    ].join('\n')
    await ask(markdown)
    const before = requests
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme
      }, theme)
      for (const [width, height] of [
        [1000, 640],
        [1280, 800],
        [1440, 900]
      ]) {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height])
        await page.getByRole('button', { name: 'View fullscreen', exact: true }).last().click()
        const surface = page.locator('[data-streamdown="table-fullscreen"]')
        const stage = surface.locator('div:has(> table)').last()
        const metrics = await stage.evaluate((el) => {
          const r = el.getBoundingClientRect(),
            table = el.querySelector('table')!.getBoundingClientRect(),
            s = getComputedStyle(el)
          const x = r.x + el.clientLeft + parseFloat(s.paddingLeft),
            y = r.y + el.clientTop + parseFloat(s.paddingTop)
          const width = el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)
          const height = el.clientHeight - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom)
          return { x, y, width, height, table: table.toJSON(), overflowX: table.width > width + 1, overflowY: table.height > height + 1 }
        })
        expect(metrics.overflowX).toBe(columns === 20)
        expect(metrics.overflowY).toBe(rows === 60)
        if (metrics.overflowX) expect(metrics.table.x).toBeGreaterThanOrEqual(metrics.x - 1)
        else expect(Math.abs(metrics.table.x + metrics.table.width / 2 - metrics.x - metrics.width / 2)).toBeLessThanOrEqual(1)
        if (metrics.overflowY) expect(metrics.table.y).toBeGreaterThanOrEqual(metrics.y - 1)
        else expect(Math.abs(metrics.table.y + metrics.table.height / 2 - metrics.y - metrics.height / 2)).toBeLessThanOrEqual(1)
        expect(await surface.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
        expect((await surface.getByRole('button', { name: 'Exit fullscreen', exact: true }).boundingBox())!.y).toBeGreaterThanOrEqual(44)
        await stage.evaluate((el) => {
          el.scrollTop = el.scrollHeight
          el.scrollLeft = el.scrollWidth
        })
        const last = await surface.locator('tbody tr').last().locator('td').last().boundingBox()
        const viewport = await stage.boundingBox()
        expect(last!.x).toBeGreaterThanOrEqual(viewport!.x)
        expect(last!.y).toBeGreaterThanOrEqual(viewport!.y)
        expect(last!.x + last!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width + 1)
        expect(last!.y + last!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height + 1)
        if (columns === 20 && rows === 60 && theme === 'dark' && width === 1000) {
          await surface.getByRole('button', { name: 'Copy table', exact: true }).click()
          await surface.getByRole('button', { name: 'Markdown', exact: true }).click()
          await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toMatch(/^\| Column01-/)
          const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
          expect(copied).toContain('R60-C20')
          const dir = mkdtempSync(join(tmpdir(), 'jiwei-layout-csv-'))
          await app.evaluate(({ BrowserWindow }, dir) => {
            BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) =>
              item.setSavePath(dir + '/' + item.getFilename())
            )
          }, dir)
          await surface.getByRole('button', { name: 'Download table', exact: true }).click()
          await surface.getByRole('button', { name: 'CSV', exact: true }).click()
          await expect.poll(() => readdirSync(dir).filter((name) => name.endsWith('.csv')).length).toBe(1)
          await expect
            .poll(() =>
              readFileSync(
                join(
                  dir,
                  readdirSync(dir).find((name) => name.endsWith('.csv'))!
                ),
                'utf8'
              )
            )
            .toContain('R60-C20')
        }
        await page.keyboard.press('Escape')
        await expect(surface).toHaveCount(0)
      }
    }
    expect(requests).toBe(before)
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })
})

test('FIX user zero and layout-clamped other axis retain separate intent', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640))
  const node = {
    type: 'table',
    columns: Array.from({ length: 6 }, (_, i) => ({ key: `c${i}`, label: `UnbreakableColumnHeading${i}` })),
    rows: Array.from({ length: 40 }, (_, r) => Object.fromEntries(Array.from({ length: 6 }, (_, c) => [`c${c}`, `R${r}ValueInColumn${c}`])))
  }
  await ask(fence(node))
  const scroll = block().locator('.ui-table-scroll')
  const entryX = await scroll.evaluate((el) => {
    el.scrollLeft = el.scrollWidth - el.clientWidth - 10
    el.scrollTop = 150
    return el.scrollLeft
  })
  expect(entryX).toBeGreaterThan(100)
  await block().getByRole('button', { name: '放大', exact: true }).click()
  const expandedScroll = expanded().locator('.ui-table-scroll')
  await expandedScroll.hover()
  await page.mouse.wheel(0, -3000)
  await expect.poll(() => expandedScroll.evaluate((el) => el.scrollTop)).toBe(0)
  await expanded().getByRole('button', { name: '退出放大', exact: true }).click()
  await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(0)
  await expect.poll(() => scroll.evaluate((el) => el.scrollLeft)).toBe(entryX)
})

test('FIX standalone table blocks a second shared surface and restores the entry', async () => {
  await ask('| 标题 | 内容 |\n| --- | --- |\n| 示例 | 短内容 |\n\n' + fence(samples.list))
  await page.getByRole('button', { name: 'View fullscreen', exact: true }).last().click()
  await block().getByRole('button', { name: '放大', exact: true }).dispatchEvent('click')
  await expect(expanded()).toHaveCount(0)
  await expect(page.locator('[data-streamdown="table-fullscreen"]')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await block().getByRole('button', { name: '放大', exact: true }).click()
  await expect(expanded()).toBeVisible()
  await expanded().getByRole('button', { name: '退出放大', exact: true }).click()
})

test('FIX fallback and text Markdown keep their permitted standalone controls', async () => {
  await ask(fence(samples.table))
  await block().getByRole('button', { name: '放大', exact: true }).click()
  await expanded().getByRole('button', { name: '组件菜单' }).click()
  await expanded().getByRole('menuitem', { name: '改成文字', exact: true }).click()
  await expect(expanded()).toHaveCount(0)
  await expect(block()).toHaveAttribute('data-ui-display', 'text')
  const verifyStandalone = async (): Promise<void> => {
    await expect(block().getByRole('button', { name: 'Copy table', exact: true })).toBeVisible()
    await expect(block().getByRole('button', { name: 'Download table', exact: true })).toBeVisible()
    await block().getByRole('button', { name: 'View fullscreen', exact: true }).click()
    const native = page.locator('[data-streamdown="table-fullscreen"]')
    await expectCentered(native.locator('div:has(> table)').last(), native.locator('table'))
    await page.keyboard.press('Escape')
    await expect(native).toHaveCount(0)
  }
  await verifyStandalone()
  await ask(fence({ ...samples.chart, kind: 'invalid-chart-kind' }))
  await expect(block()).toHaveAttribute('data-ui-state', 'fallback')
  await verifyStandalone()
  await ask(Array.from({ length: 4 }, () => fence(samples.table)).join('\n\n'))
  await block().locator('summary').click()
  await expect(block().getByRole('button', { name: '放大', exact: true })).toHaveCount(0)
  await verifyStandalone()
})

test('FIX async loading, empty note and unavailable data stay aligned', async () => {
  await navTo(page, /笔记/)
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('异步空笔记布局验收')
  await expect
    .poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '异步空笔记布局验收' }).then((notes) => notes.length)))
    .toBe(1)
  const noteId = await page.evaluate(async () => (await window.jiwei.notes.list({ search: '异步空笔记布局验收' }))[0].id)
  await navTo(page, /AI 对话/)
  await app.evaluate(({ ipcMain }, id) => {
    type Handler = (...args: unknown[]) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const original = handlers.get('notes:get')!
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    ipcMain.removeHandler('notes:get')
    ipcMain.handle('notes:get', async (...args) => {
      if (args[1] === id) await gate
      return original(...args)
    })
    ;(globalThis as unknown as { layoutDataGate: { release(): void; restore(): void } }).layoutDataGate = {
      release,
      restore() {
        release()
        ipcMain.removeHandler('notes:get')
        ipcMain.handle('notes:get', original)
      }
    }
  }, noteId)
  try {
    await ask(fence({ type: 'note', noteId }))
    await expect(block()).toContainText('正在读取…')
    await block().getByRole('button', { name: '放大', exact: true }).click()
    await expectCentered(expanded().locator('.ui-frame-body'), expanded().locator('.ui-frame-content'))
    await app.evaluate(() => (globalThis as unknown as { layoutDataGate: { release(): void } }).layoutDataGate.release())
    await expect(expanded()).toContainText('异步空笔记布局验收')
    await expect(expanded()).not.toContainText('正在读取…')
    await expectCentered(expanded().locator('.ui-frame-body'), expanded().locator('.ui-frame-content'))
    await page.keyboard.press('Escape')
  } finally {
    await app.evaluate(() => (globalThis as unknown as { layoutDataGate: { restore(): void } }).layoutDataGate.restore())
  }
  await ask(fence({ type: 'note', noteId: 'missing-layout-note' }))
  await expect(block().getByRole('status')).toBeVisible()
  await block().getByRole('button', { name: '放大', exact: true }).click()
  await expect(expanded().getByRole('status')).toBeVisible()
  await expectCentered(expanded().locator('.ui-frame-body'), expanded().locator('.ui-frame-content'))
  await page.keyboard.press('Escape')
})

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
  const settings = page.getByRole('dialog').filter({ has: page.getByRole('tab', { name: 'AI 模型', exact: true }) })
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

test('FIX long unbroken reading content remains within its centered group', async () => {
  const list = { type: 'list', items: [{ text: 'W'.repeat(200) }] }
  for (const node of [
    list,
    {
      type: 'tabs',
      tabs: [
        { label: '图文组合', children: [samples.chart, list] },
        { label: '短选项', children: [samples.choice] }
      ]
    }
  ]) {
    await ask(fence(node))
    await expect(block()).toHaveAttribute('data-ui-state', 'ready')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640))
    await block().getByRole('button', { name: '放大', exact: true }).click()
    const content = expanded().locator('.ui-frame-content')
    await expectSafeAlignment(expanded().locator('.ui-frame-body'), content)
    const text = await expanded().locator('li div span').boundingBox()
    const group = await content.boundingBox()
    expect(text!.x).toBeGreaterThanOrEqual(group!.x)
    expect(text!.x + text!.width).toBeLessThanOrEqual(group!.x + group!.width + 1)
    await page.keyboard.press('Escape')
  }
  expect(
    await app.evaluate(() => (globalThis as unknown as { fullscreenWindowEvents: Record<string, number> }).fullscreenWindowEvents)
  ).toEqual({ close: 0, closed: 0, hide: 0 })
})
