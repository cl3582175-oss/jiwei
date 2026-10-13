import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'http'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { currentNav, navTo } from './fixtures/nav'

// v0.6.7：「今日」首页、导航分组、学习活动记录、积微助手统一。
// 受控的模型服务：结构化调用（晨报）返回固定文字，对话流返回一句话；记录收到的全部请求。

const shots = process.env.SHOTS_DIR
const BRIEF = '受控晨报：先把逾期的“重做第三章错题”处理掉，再复习到期的卡片。'
let app: ElectronApplication, page: Page, provider: Server
const requests: { body: string; stream: boolean }[] = []
let userData = ''

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
}
const shot = async (name: string): Promise<void> => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}
/** 只读本用例临时库的活动记录 */
async function activityRows(): Promise<{ kind: string; ref_type: string | null; duration_ms: number }[]> {
  return app.evaluate(({ app }) => {
    const path = process.getBuiltinModule('path')
    const requireFromApp = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json'))
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(path.join(app.getPath('userData'), 'data', 'jiwei.db'), { readonly: true })
    try {
      return db.prepare('SELECT kind, ref_type, duration_ms FROM activity_events ORDER BY at').all() as {
        kind: string
        ref_type: string | null
        duration_ms: number
      }[]
    } finally {
      db.close()
    }
  })
}

test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  provider = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      const input = JSON.parse(body) as { stream?: boolean; tools?: { function: { name: string } }[] }
      requests.push({ body, stream: !!input.stream })
      if (input.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const chunk = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'today-fixture', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
        res.write(chunk({ role: 'assistant', content: '先处理逾期的行动项。' }, null))
        res.write(chunk({}, 'stop'))
        res.end('data: [DONE]\n\n')
        return
      }
      const call = { id: 's', type: 'function', function: { name: 'submit', arguments: JSON.stringify({ text: BRIEF }) } }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({
            id: 'r',
            object: 'chat.completion',
            created: 1,
            model: 'today-fixture',
            choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
          })
        )
    })
  })
  await new Promise<void>((r) => provider.listen(0, '127.0.0.1', r))
  userData = mkdtempSync(join(tmpdir(), 'jiwei-today-'))
  await launch()
})
test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((r) => provider.close(() => r()))
})

test('全新用户：默认打开「今日」，导航为助手 + 四组，晨报按模板生成', async () => {
  await expect(page.getByTestId('today-view')).toBeVisible()
  await expect(page.getByTestId('today-fresh')).toBeVisible()
  const rail = page.getByTestId('nav-rail')
  await expect(rail.getByRole('button', { name: /^积微助手/ })).toBeVisible()
  for (const g of ['今日', '收集', '学习', '计划'])
    await expect(rail.getByRole('button', { name: new RegExp(`^${g}`) }).first()).toBeVisible()
  // 「今日」只有一项，不展开；其他组的子项此时不显示
  await expect(rail.getByRole('button', { name: /^资料库/ })).toHaveCount(0)
  // 没有模型：模板晨报 + 说明
  await expect(page.getByTestId('today-briefing-text')).toContainText('从一件小事开始')
  await expect(page.getByTestId('today-briefing')).toContainText('未设置 AI 模型')
  await shot('today-fresh')
})

test('导航分组：点组只展开卡片，页面不变；点卡片入口才跳转；⌘9 回到今日', async () => {
  const rail = page.getByTestId('nav-rail')
  await rail.getByRole('button', { name: /^学习/ }).click()
  await expect(page.getByTestId('today-view')).toBeVisible()
  await page.getByTestId('nav-ring').getByRole('menuitem', { name: /^笔记/ }).click()
  await expect(currentNav(page, '学习', '笔记')).toBeVisible()
  await navTo(page, /^图谱/)
  await page.keyboard.press('ControlOrMeta+9')
  await expect(page.getByTestId('today-view')).toBeVisible()
  await rail.getByRole('button', { name: /^学习/ }).click()
  await expect(page.getByTestId('today-view')).toBeVisible()
  await page.getByTestId('nav-ring').getByRole('menuitem', { name: /^图谱/ }).click()
  await expect(currentNav(page, '学习', '图谱')).toBeVisible()
  // 收集组：资料库；计划组：方向、复盘
  await navTo(page, /^资料库/)
  await expect(currentNav(page, '收集', '资料库')).toBeVisible()
  await navTo(page, /^方向/)
  await expect(page.getByTestId('goals-view')).toBeVisible()
  // 方向只在「计划」里，复习页不再有这个标签
  await expect(page.getByRole('tab', { name: '方向' })).toHaveCount(0)
  await expect(currentNav(page, '计划', '方向')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+9')
})

test('有数据时：今天要做、行动项可完成、目标与投入时长；设置模型后晨报由 AI 生成', async () => {
  const baseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`
  await page.evaluate(async (baseUrl) => {
    const j = window.jiwei
    for (const title of ['间隔重复与遗忘曲线', '费曼学习法']) {
      const n = await j.notes.create({ categoryId: null })
      await j.notes.update(n.id, { title })
    }
    await j.goals.save({ title: '六月通过考研数学一', targetAt: Date.now() + 40 * 86400000 })
    await j.actions.create('重做第三章错题', Date.now() - 86400000, null)
    await j.actions.create('整理周会纪要', new Date().setHours(23, 0, 0, 0), null)
    await j.inbox.create({ kind: 'text', text: '看一下 FSRS 论文', origin: {} })
    await j.activity.track([
      { kind: 'read', refType: null, refId: null, durationMs: 15 * 60000 },
      { kind: 'write', refType: null, refId: null, durationMs: 9 * 60000 }
    ])
    // 数据准备好之后再设置模型：模板晨报换成 AI 晨报
    const p = await j.providers.save({ kind: 'ollama', name: 'Today fixture', baseUrl, models: ['today-fixture'] })
    const s = await j.settings.get()
    await j.settings.set({ ai: { ...s.ai, chat: { providerId: p.id, model: 'today-fixture' }, effort: 'off' } })
  }, baseUrl)
  await page.reload()
  await page.waitForSelector('nav')
  const todo = page.getByTestId('today-todo')
  await expect(todo).toContainText('重做第三章错题')
  await expect(todo).toContainText('已逾期')
  await expect(todo).toContainText('整理周会纪要')
  await expect(todo).toContainText('收件箱有 1 条待整理')
  await expect(page.getByTestId('today-minutes')).toContainText('24 分钟')
  await expect(page.getByTestId('today-minutes')).toContainText('阅读 15')
  await expect(page.getByText('六月通过考研数学一')).toBeVisible()
  // 要点变了（全新 → 有内容、有行动项），晨报重新生成，这次由模型生成
  await expect(page.getByTestId('today-briefing-text')).toHaveText(BRIEF, { timeout: 30000 })
  const brief = requests.filter((r) => !r.stream && r.body.includes('<today>')).at(-1)!
  expect(brief.body).toContain('重做第三章错题')
  expect(brief.body).not.toContain('看一下 FSRS 论文') // 收件箱内容不发给模型，只发数量
  await shot('today-filled')
  // 完成一个行动项
  await page.getByTestId('today-action').filter({ hasText: '整理周会纪要' }).getByRole('button', { name: '标记完成' }).click()
  await expect(todo).not.toContainText('整理周会纪要')
  // 热力图也计入有效学习时长
  const heat = await page.evaluate(() => window.jiwei.stats.heatmap(1))
  expect(heat[0].count).toBeGreaterThanOrEqual(2)
})

test('积微助手：⌘J 在今日页打开侧栏并附带当前页面，可展开为全屏继续', async () => {
  await page.keyboard.press('ControlOrMeta+j')
  const panel = page.getByRole('complementary', { name: /积微助手/ })
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('当前页面：今日')
  await expect(panel.getByRole('button', { name: '今天我应该先做什么？' })).toBeVisible()
  await shot('today-assistant-panel')
  await panel.getByRole('button', { name: '今天我应该先做什么？' }).click()
  await expect(panel).toContainText('先处理逾期的行动项。')
  const chat = requests.filter((r) => r.stream).at(-1)!
  expect(chat.body).toContain('用户当前所在的页面')
  expect(chat.body).toContain('重做第三章错题')
  await panel.getByRole('button', { name: '展开为全屏' }).click()
  await expect(page.getByTestId('nav-rail').getByRole('button', { name: /^积微助手/ })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByText('先处理逾期的行动项。')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+9')
})

test('今日输入框与回复晨报：进入助手页自动发送，晨报作为上下文', async () => {
  await page.getByTestId('today-briefing').getByRole('button', { name: '回复' }).click()
  await expect(page.getByTestId('today-ask')).toContainText('回复晨报')
  const before = requests.filter((r) => r.stream).length
  await page.getByRole('textbox', { name: '问积微，或交代一件事……' }).first().fill('好，先做哪一步？')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('nav-rail').getByRole('button', { name: /^积微助手/ })).toHaveAttribute('aria-current', 'page')
  await expect.poll(() => requests.filter((r) => r.stream).length).toBeGreaterThan(before)
  const chat = requests.filter((r) => r.stream).at(-1)!
  expect(chat.body).toContain('好，先做哪一步？')
  expect(chat.body).toContain('受控晨报')
  await expect(page.getByText('先处理逾期的行动项。').last()).toBeVisible()
})

test('学习活动：写笔记的有效时长被记录，切到别处立即上报；设置中可以清除', async () => {
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('活动记录验证')
  await page.keyboard.press('Enter')
  for (let i = 0; i < 4; i++) {
    await page.keyboard.type('写一点内容。')
    await page.waitForTimeout(3000)
  }
  // 模拟切到其他应用：页面不可见时立即上报
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect
    .poll(async () => (await activityRows()).some((r) => r.kind === 'write' && r.ref_type === 'note' && r.duration_ms >= 10000))
    .toBe(true)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })
  // 清除
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('dialog').getByRole('button', { name: /^数据/ }).click()
  await page.getByTestId('activity-settings').getByRole('button', { name: '清除活动记录' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '清除活动记录' }).click()
  await expect.poll(async () => (await activityRows()).length).toBe(0)
  await page.keyboard.press('Escape')
})

test('1000×680：今日页不横向溢出，导航可滚动', async () => {
  await page.keyboard.press('ControlOrMeta+9')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  await expect(page.getByTestId('today-view')).toBeVisible()
  expect(await page.getByTestId('today-view').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await shot('today-1000x680')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
})
