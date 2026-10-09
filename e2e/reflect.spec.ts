import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 复盘（不需要 API Key）：每日微复盘、行动项、每周复盘（素材包 + 康奈尔引导问题）、专题复盘、洞见与版本、提醒设置。
// 设置 JIWEI_IMPORT_PROVIDERS_FROM 时额外测试 AI 追问与整理洞见 / 行动项。
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
const shots = process.env.SHOTS_DIR
const live = !!process.env.JIWEI_IMPORT_PROVIDERS_FROM

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-reflect-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', ...(live ? {} : { JIWEI_IMPORT_PROVIDERS_FROM: '' }) }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  // 一篇今天学的笔记（素材）
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('统计学：p 值')
  await page.keyboard.press('Enter')
  await page.keyboard.type('p 值是在原假设成立时，观察到当前或更极端结果的概率。')
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: 'p 值' }).then((n) => n.length))).toBeGreaterThan(0)
})
test.afterAll(async () => {
  await app?.close()
})

test('daily one-minute reflection; tomorrow becomes an action item', async () => {
  await page.keyboard.press('ControlOrMeta+5')
  const daily = page.getByTestId('daily-card')
  await expect(daily).toBeVisible()
  await daily.getByRole('textbox', { name: '今天学了什么？' }).fill('p 值的含义：原假设成立时出现这么极端结果的概率。')
  await daily.getByRole('textbox', { name: '还有什么没想明白？' }).fill('p 值和显著性水平的关系。')
  await daily.getByRole('textbox', { name: '明天做一件什么事？' }).fill('用自己的数据算一次 p 值')
  await daily.getByRole('button', { name: '保存' }).click()
  await expect(daily).toContainText('今天已复盘')
  const actions = page.getByTestId('actions-card')
  await expect(actions).toContainText('用自己的数据算一次 p 值')
  await expect(actions).toContainText('明天')
  const o = await page.evaluate(() => window.jiwei.reflection.overview())
  expect(o.today?.status).toBe('done')
  // 复盘笔记：康奈尔结构，线索栏是问题
  const note = await page.evaluate((id) => window.jiwei.notes.get(id), o.today!.noteId!)
  expect(note?.kind).toBe('review')
  expect(JSON.stringify(await page.evaluate((id) => window.jiwei.notes.blocks(id), o.today!.noteId!))).toContain('还有什么没想明白？')
  // 再次编辑：回填已写的内容
  await daily.getByRole('button', { name: '修改' }).click()
  await expect(daily.getByRole('textbox', { name: '还有什么没想明白？' })).toHaveValue('p 值和显著性水平的关系。')
  await daily.getByRole('button', { name: '保存' }).click()
  // 行动项：勾选完成
  await actions.getByRole('checkbox', { name: '用自己的数据算一次 p 值' }).click()
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.actions.list('done'))).length).toBe(1)
  if (shots) await page.screenshot({ path: join(shots, '141-reflect-home.png') })
})

test('weekly review: material pack beside the GRAI note', async () => {
  await page.getByTestId('weekly-card').getByRole('button', { name: '开始本周复盘' }).click()
  await expect(page.locator('.cornell-doc')).toContainText('目标：这周原本想学会什么？')
  await expect(page.locator('.cornell-doc')).toContainText('行动：下周具体做什么？')
  const material = page.getByTestId('material')
  await expect(material).toContainText('统计学：p 值')
  await expect(material).toContainText('学习的笔记')
  if (shots) await page.screenshot({ path: join(shots, '142-reflect-weekly.png') })
  // 同一周只有一份
  const a = await page.evaluate(() => window.jiwei.reflection.start({ kind: 'weekly' }))
  const b = await page.evaluate(() => window.jiwei.reflection.start({ kind: 'weekly' }))
  expect(a.id).toBe(b.id)
  await page.getByRole('button', { name: '返回复盘首页' }).click()
  await expect(page.getByTestId('weekly-card')).toContainText('继续本周复盘')
})

test('topic review and insights with versions', async () => {
  await page.getByRole('button', { name: /主题复盘/ }).click()
  await page.getByRole('alertdialog').getByRole('textbox').fill('统计学基础')
  await page.getByRole('alertdialog').getByRole('button', { name: '开始' }).click()
  await expect(page.locator('.cornell-doc')).toContainText('用自己的话说，这个主题的核心是什么？')
  const r = await page.evaluate(() => window.jiwei.reflection.overview().then((o) => o.recent.find((x) => x.kind === 'topic')!))
  expect(r.title).toBe('主题复盘：统计学基础')
  // 保存一条洞见（AI 整理后由用户确认的同一接口）
  await page.evaluate(
    (id) =>
      window.jiwei.reflection.commit(id, {
        insights: [{ statement: '多读几遍不等于记住，主动回忆才有用', confidence: 'believed', evidence: '复习时忘得最多的都是只读过的' }],
        revisions: [],
        actions: [{ title: '每天复习 10 张卡片', dueAt: null }]
      }),
    r.id
  )
  await page.getByRole('button', { name: '返回复盘首页' }).click()
  const insights = page.getByTestId('insights-card')
  await insights.getByRole('button', { name: /多读几遍不等于记住/ }).click()
  // 修正：新版本 + 原因 → 认知变化轨迹
  await page.getByRole('button', { name: '修正' }).click()
  await page.getByRole('alertdialog').getByRole('textbox').fill('只读不练记不住；间隔重复 + 主动回忆才有效')
  await page.getByRole('alertdialog').getByRole('button', { name: '保存' }).click()
  await page.getByRole('alertdialog').getByRole('textbox').fill('这周用复习卡片后，记住比例明显提高')
  await page.getByRole('alertdialog').getByRole('button', { name: '保存' }).click()
  const history = page.getByTestId('insight-history')
  await expect(history.locator('li')).toHaveCount(2)
  await expect(history).toContainText('v2')
  await expect(history).toContainText('这周用复习卡片后，记住比例明显提高')
  await expect(history).toContainText('复习时忘得最多的都是只读过的')
  if (shots) await page.screenshot({ path: join(shots, '143-insight-history.png') })
  await page.keyboard.press('Escape')
  const list = await page.evaluate(() => window.jiwei.insights.list())
  expect(list[0]).toMatchObject({ version: 2, statement: '只读不练记不住；间隔重复 + 主动回忆才有效' })
})

test('reminder settings', async () => {
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('dialog').getByRole('button', { name: '学习', exact: true }).click()
  await page.getByRole('switch', { name: '每周复盘' }).click()
  await page.getByRole('button', { name: '周五', exact: true }).click()
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.settings.get())).reflection)
    .toMatchObject({ weekly: false, weeklyDay: 5 })
  await page.keyboard.press('Escape')
})

test('AI asks Socratic questions and wraps up insights and actions (live)', async () => {
  test.skip(!live, '需要 JIWEI_IMPORT_PROVIDERS_FROM')
  test.setTimeout(300_000)
  await page.keyboard.press('ControlOrMeta+5')
  await page.getByTestId('weekly-card').getByRole('button', { name: /本周复盘/ }).click()
  // 在 GRAI 各问题的笔记栏中写回答
  const bodies = page.locator('.cornell-doc .cornell-body')
  const answers = [
    '想把统计学里的 p 值和假设检验弄懂，能自己分析 A/B 测试。',
    'p 值的定义能说清楚了，但显著性水平和 p 值的关系还是模糊，也还没实际算过。',
    '复习卡片很有用：忘了的问题第二天再出现，印象深了很多。只看视频不做题的那几天几乎没留下什么。',
    '光看懂不算学会，要自己讲出来、做出来才算。',
    '下周用公司上个月的转化数据做一次完整的 A/B 检验。'
  ]
  for (const [i, a] of answers.entries()) {
    await bodies.nth(i).click()
    await page.keyboard.type(a)
  }
  await expect.poll(async () => JSON.stringify(await page.evaluate(() => window.jiwei.reflection.overview()))).toBeTruthy()
  await page.waitForTimeout(800)
  // AI 追问
  await page.getByRole('tab', { name: 'AI 追问' }).click()
  await page.getByRole('button', { name: '开始追问' }).click()
  const reply = page.locator('.group\\/msg').last()
  // 生成完成：发送按钮恢复（停止按钮消失）
  await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0, { timeout: 120_000 })
  await expect(reply).not.toBeEmpty()
  const q = (await reply.innerText()).trim()
  expect(q).not.toContain('没有引用你的知识库')
  console.log('coach:', q)
  expect(q).toMatch(/[？?]/)
  if (shots) await page.screenshot({ path: join(shots, '144-reflect-coach.png') })
  // 完成：整理洞见与行动项
  await page.getByRole('button', { name: '完成复盘' }).click()
  const dlg = page.getByTestId('harvest')
  await expect(dlg).toBeVisible({ timeout: 120_000 })
  console.log('harvest:', (await dlg.innerText()).replace(/\s+/g, ' ').slice(0, 600))
  await expect(dlg.getByRole('checkbox').first()).toBeChecked()
  if (shots) await page.screenshot({ path: join(shots, '145-reflect-harvest.png') })
  await dlg.getByRole('button', { name: '完成' }).click()
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.reflection.overview())).week?.status).toBe('done')
  const acts = await page.evaluate(() => window.jiwei.actions.list('open'))
  expect(acts.some((a) => /A\/B|转化/.test(a.title))).toBe(true)
  expect((await page.evaluate(() => window.jiwei.insights.list())).length).toBeGreaterThan(1)
})
