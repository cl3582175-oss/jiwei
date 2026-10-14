import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { navTo } from './fixtures/nav'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page, server: Server
let answer = '',
  providerId = ''
const requests: unknown[] = []
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
      const text = answer
      let offset = 0
      const send = (delta: unknown, finish: string | null): void => {
        res.write(
          `data: ${JSON.stringify({ id: 'ui', object: 'chat.completion.chunk', created: 1, model: 'test-ui', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        )
      }
      const interval = setInterval(() => {
        if (offset < text.length) {
          send({ content: text.slice(offset, offset + 10) }, null)
          offset += 10
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
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-ui-'))}`],
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
