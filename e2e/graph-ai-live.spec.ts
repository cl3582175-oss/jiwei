import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 知识图谱 v0.14.3 真实模型验收：AI 整理关系（建议 → 确认）、学习路径、知识缺口、时间回放。
// 运行：JIWEI_GRAPH_LIVE=1 JIWEI_IMPORT_PROVIDERS_FROM=<应用数据库 jiwei.db> npx playwright test e2e/graph-ai-live.spec.ts
// 服务商以加密形态复制到临时目录；不碰真实笔记。截图写到 GRAPH_SHOTS（可选）。
test.skip(
  process.env.JIWEI_GRAPH_LIVE !== '1' || !process.env.JIWEI_IMPORT_PROVIDERS_FROM,
  '需要 JIWEI_GRAPH_LIVE=1 与 JIWEI_IMPORT_PROVIDERS_FROM'
)
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
const shots = process.env.GRAPH_SHOTS
const ids: Record<string, string> = {}
const shot = async (name: string): Promise<void> => {
  if (!shots) return
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: join(shots, `${name}.png`) })
}

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-graph-live-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

type Part = string | { link: string; text: string }
const para = (parts: Part[]) => ({
  type: 'paragraph',
  content: parts.map((p) =>
    typeof p === 'string'
      ? { type: 'text', text: p }
      : { type: 'text', text: p.text, marks: [{ type: 'link', attrs: { href: `jiwei://note/${p.link}` } }] }
  )
})
test('seed notes with real content and links', async () => {
  test.setTimeout(240_000)
  const econ = await page.evaluate(() => window.jiwei.categories.create('note', '经济学'))
  const stats = await page.evaluate(() => window.jiwei.categories.create('note', '统计学'))
  const learn = await page.evaluate(() => window.jiwei.categories.create('note', '学习方法'))
  const make = async (title: string, cat: { id: string }, parts: Part[]): Promise<void> => {
    await page.keyboard.press('ControlOrMeta+n')
    await page.getByPlaceholder('笔记标题').fill(title)
    await page.keyboard.press('Enter')
    await page.keyboard.type(' ')
    await expect
      .poll(() => page.evaluate((t) => window.jiwei.notes.list({ search: t }).then((n) => n.some((x) => x.title === t)), title))
      .toBe(true)
    ids[title] = await page.evaluate((t) => window.jiwei.notes.list({ search: t }).then((n) => n.find((x) => x.title === t)!.id), title)
    await page.evaluate(({ id, categoryId }) => window.jiwei.notes.update(id, { categoryId }), { id: ids[title], categoryId: cat.id })
    await page.evaluate(
      ({ id, body }) =>
        window.jiwei.proposals.create({ noteId: id, title: '内容', ops: [{ op: 'insert_row', afterRowId: null, cue: [], body: [body] }] }),
      { id: ids[title], body: para(parts) }
    )
    await page.getByRole('button', { name: '全部接受' }).click()
    await expect(page.getByRole('button', { name: '全部接受' })).toHaveCount(0)
  }
  await make('边际效用', econ, ['每多消费一单位商品，带来的额外满足感会递减，这叫边际效用递减。'])
  await make('需求曲线', econ, [
    '需求曲线向右下方倾斜，正是因为',
    { link: ids['边际效用'], text: '边际效用' },
    '递减：价格越低，人们愿意多买。'
  ])
  await make('市场均衡', econ, [
    '供给与',
    { link: ids['需求曲线'], text: '需求曲线' },
    '的交点决定均衡价格和数量；要先理解需求曲线才能理解均衡。'
  ])
  await make('机会成本', econ, ['选择一样东西时放弃的其他最好选择的价值。常和沉没成本混淆，但它看的是未来。'])
  await make('沉没成本', econ, [
    '已经付出、无法收回的成本。与',
    { link: ids['机会成本'], text: '机会成本' },
    '不同，理性决策时应忽略沉没成本。'
  ])
  await make('中心极限定理', stats, ['大量独立样本的均值近似服从正态分布，这是构造置信区间的理论基础。'])
  await make('置信区间', stats, ['借助', { link: ids['中心极限定理'], text: '中心极限定理' }, '，可以给出参数可能落入的区间。'])
  await make('p 值', stats, [
    '原假设成立时，出现当前或更极端结果的概率。它和',
    { link: ids['置信区间'], text: '置信区间' },
    '是两种不同的推断表达，常被混用。'
  ])
  await make('A/B 测试', stats, ['比较两个版本时，用', { link: ids['p 值'], text: 'p 值' }, '判断差异是否显著；做 A/B 测试前得先懂 p 值。'])
  await make('间隔重复', learn, ['把复习安排在快要遗忘的时候，间隔逐渐拉长。'])
  await make('提取练习', learn, ['主动回忆比重读更有效。', { link: ids['间隔重复'], text: '间隔重复' }, '里每次复习本身就是一次提取练习。'])
  await make('费曼学习法', learn, ['用简单的话讲给别人听，讲不清的地方就是没懂。'])
  await page.evaluate((id) => window.jiwei.notes.update(id, { status: 'outdated' }), ids['沉没成本'])
  const g = await page.evaluate(() => window.jiwei.graph.data())
  expect(g.nodes.filter((n) => n.type === 'note')).toHaveLength(12)
  expect(g.edges.length).toBeGreaterThanOrEqual(6)
})

test('AI organizes relations: suggestions only, accept one, reject one', async () => {
  test.setTimeout(300_000)
  await page.keyboard.press('ControlOrMeta+6')
  await page.getByTestId('graph-discover-toggle').click()
  await expect(page.getByTestId('graph-discover')).toBeVisible()
  const before = await page.evaluate(() => window.jiwei.graph.data())
  await page.getByTestId('graph-suggest').click()
  await expect(page.getByTestId('graph-suggest')).toContainText('整理关系', { timeout: 240_000 })
  const after = await page.evaluate(() => window.jiwei.graph.data())
  const suggested = after.edges.filter((e) => e.status === 'suggested')
  console.log('[graph-live] suggestions:', suggested.map((e) => `${e.from}→${e.to} ${e.relation} ${e.reason}`).join(' | '))
  expect(suggested.length).toBeGreaterThan(0)
  // 建议不改变已确认的关系
  expect(after.edges.filter((e) => e.status === 'confirmed' && e.relation !== 'related').length).toBe(
    before.edges.filter((e) => e.status === 'confirmed' && e.relation !== 'related').length
  )
  for (const e of suggested) expect(e.reason, '每条建议都有理由').toBeTruthy()
  await page.waitForTimeout(1500)
  await shot('live-discover')
  const list = page.getByTestId('graph-suggestions').locator('li')
  await list.first().getByRole('button', { name: '确认' }).click()
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.graph.data())).edges.filter((e) => e.status === 'suggested').length)
    .toBe(suggested.length - 1)
  if (suggested.length > 1) {
    await list.first().getByRole('button', { name: '不对' }).click()
    await expect
      .poll(async () => (await page.evaluate(() => window.jiwei.graph.data())).edges.filter((e) => e.status === 'suggested').length)
      .toBe(suggested.length - 2)
  }
  // 再整理一次：判断过的不再重复
  await page.getByTestId('graph-suggest').click()
  await expect(page.getByTestId('graph-suggest')).toContainText('整理关系', { timeout: 240_000 })
  const again = await page.evaluate(() => window.jiwei.graph.data())
  expect(again.edges.filter((e) => e.status === 'suggested').length).toBeLessThanOrEqual(Math.max(0, suggested.length - 1))
  await shot('live-graph')
})

test('learning path, gaps and timeline', async () => {
  // 确保至少有一条前置关系
  await page.evaluate(({ a, b }) => window.jiwei.connections.relate(a, 'note', b, 'prerequisite'), { a: ids['p 值'], b: ids['A/B 测试'] })
  await page.evaluate(({ a, b }) => window.jiwei.connections.relate(a, 'note', b, 'prerequisite'), {
    a: ids['需求曲线'],
    b: ids['市场均衡']
  })
  await page.getByTestId('graph-discover-toggle').click()
  await page.getByRole('tab', { name: '学习路径' }).click()
  await expect(page.getByTestId('graph-path')).toBeVisible()
  await expect(page.getByTestId('graph-path-frontier')).toContainText('可以学了')
  await expect(page.locator('[data-path-node="A/B 测试"]')).toBeVisible()
  await shot('live-path')
  await page.getByRole('tab', { name: '图', exact: true }).click()
  await page.getByTestId('graph-discover-toggle').click()
  await expect(page.getByTestId('graph-gaps')).toBeVisible()
  await page.getByTestId('graph-discover-toggle').click()
  await page.getByRole('button', { name: '时间回放' }).click()
  await expect(page.getByTestId('graph-timeline')).toBeVisible()
  await page.waitForTimeout(2500)
  await shot('live-timeline')
  await page.getByTestId('graph-timeline').getByRole('button', { name: '取消选中' }).click()
})
