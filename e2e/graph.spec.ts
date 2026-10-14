import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 知识结构图（v0.5.1）：数据、WebGL 渲染、按分类 / 掌握度着色、搜索、局部图。
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
const shots = process.env.SHOTS_DIR
const ids: Record<string, string> = {}

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-graph-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
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

async function note(title: string, categoryId: string | null, parts: Part[] = ['内容']): Promise<string> {
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill(title)
  await page.keyboard.press('Enter')
  await page.keyboard.type(' ')
  await expect
    .poll(() => page.evaluate((t) => window.jiwei.notes.list({ search: t }).then((n) => n.some((x) => x.title === t)), title))
    .toBe(true)
  const id = await page.evaluate((t) => window.jiwei.notes.list({ search: t }).then((n) => n.find((x) => x.title === t)!.id), title)
  if (categoryId) await page.evaluate(({ id, categoryId }) => window.jiwei.notes.update(id, { categoryId }), { id, categoryId })
  await page.evaluate(
    ({ id, body }) =>
      window.jiwei.proposals.create({ noteId: id, title: '内容', ops: [{ op: 'insert_row', afterRowId: null, cue: [], body: [body] }] }),
    { id, body: para(parts) }
  )
  await page.getByRole('button', { name: '全部接受' }).click()
  await expect(page.getByRole('button', { name: '全部接受' })).toHaveCount(0)
  return id
}

test('graph data: notes, links, related connections', async () => {
  const econ = await page.evaluate(() => window.jiwei.categories.create('note', '经济学'))
  const stats = await page.evaluate(() => window.jiwei.categories.create('note', '统计学'))
  ids.mu = await note('边际效用', econ.id, ['每多消费一单位，满足感递减。'])
  ids.demand = await note('需求曲线', econ.id, ['需求曲线向下倾斜，原因是', { link: ids.mu, text: '边际效用' }, '递减。'])
  ids.cost = await note('边际成本', econ.id, ['和', { link: ids.mu, text: '边际效用' }, '对照着看。'])
  ids.p = await note('p 值', stats.id, ['原假设成立时出现极端结果的概率。'])
  ids.ab = await note('A/B 测试', stats.id, [
    '用',
    { link: ids.p, text: 'p 值' },
    '判断差异是否显著，也要看',
    { link: ids.demand, text: '需求曲线' },
    '。'
  ])
  ids.lonely = await note('孤立的笔记', null, ['还没有和任何笔记相连。'])
  await page.evaluate(({ a, b }) => window.jiwei.connections.relate(a, 'note', b), { a: ids.p, b: ids.cost })
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.graph.data())).edges.length, { timeout: 10_000 }).toBe(5)
  const g = await page.evaluate(() => window.jiwei.graph.data())
  expect(g.nodes.filter((n) => n.type === 'note')).toHaveLength(6)
  expect(g.edges.filter((e) => e.kind === 'related')).toHaveLength(1)
  expect(g.categories.map((c) => c.name).sort()).toEqual(['经济学', '统计学'])
  expect(g.nodes.find((n) => n.id === ids.lonely)!.categoryId).toBeNull()
})

test('graph view renders with WebGL; colour modes, search', async () => {
  await page.keyboard.press('ControlOrMeta+6')
  await expect(page.getByTestId('graph-count')).toHaveText('6 篇笔记 · 0 份资料 · 5 条连线')
  await expect(page.getByTestId('graph-canvas').locator('canvas').first()).toBeVisible()
  await expect(page.getByTestId('graph-legend')).toContainText('经济学')
  await page.waitForTimeout(2500)
  if (shots) await page.screenshot({ path: join(shots, '171-graph.png') })
  await page.getByRole('tab', { name: '按掌握度' }).click()
  await expect(page.getByTestId('graph-legend')).toContainText('空白')
  await page.getByRole('textbox', { name: '查找笔记' }).fill('需求')
  await page.getByRole('option', { name: '需求曲线' }).click()
  await page.getByRole('button', { name: '打开' }).click()
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('需求曲线')
})

test('local graph from a note: only nodes within two steps', async () => {
  // 在“需求曲线”中打开局部图
  await page.getByRole('button', { name: '局部图' }).click()
  await expect(page.getByTestId('graph-focus')).toContainText('需求曲线')
  // 需求曲线 → 边际效用、A/B 测试（一步）→ 边际成本、p 值（两步）；孤立的笔记不在其中
  await expect(page.getByTestId('graph-count')).toHaveText('5 篇笔记 · 0 份资料 · 5 条连线')
  if (shots) {
    await page.waitForTimeout(2000)
    await page.screenshot({ path: join(shots, '172-graph-local.png') })
  }
  await page.getByRole('button', { name: '显示全部' }).click()
  await expect(page.getByTestId('graph-count')).toHaveText('6 篇笔记 · 0 份资料 · 5 条连线')
})

test('v0.14.2 relation types: change a text link to prerequisite in the panel, list view reads it as a sentence', async () => {
  await page.keyboard.press('ControlOrMeta+6')
  await page.getByRole('textbox', { name: '查找笔记' }).fill('A/B')
  await page.getByRole('option', { name: 'A/B 测试' }).click()
  const panel = page.getByTestId('graph-panel')
  await expect(panel).toContainText('A/B 测试')
  // 正文里 A/B 测试 → p 值 的链接，在面板里改成“p 值 是 A/B 测试 的前置”
  const row = panel.getByTestId('graph-relations').locator('li').filter({ hasText: 'p 值' })
  await expect(row).toContainText('正文链接')
  await row.getByRole('combobox', { name: '关系类型' }).selectOption('prerequisite|1')
  await expect
    .poll(async () => {
      const g = await page.evaluate(() => window.jiwei.graph.data())
      return g.edges.find((e) => [e.from, e.to].sort().join() === [`note:${ids.p}`, `note:${ids.ab}`].sort().join())
    })
    .toMatchObject({ from: `note:${ids.p}`, to: `note:${ids.ab}`, relation: 'prerequisite', kind: 'related' })
  // 正文链接和手动关系是同一对笔记：图上仍只算一条连线
  await expect(page.getByTestId('graph-count')).toHaveText('6 篇笔记 · 0 份资料 · 5 条连线')
  await expect(panel.getByTestId('graph-relations')).toContainText('学 《A/B 测试》 之前要先懂 《p 值》')
  await page.getByRole('tab', { name: '关系列表' }).click()
  await expect(page.getByTestId('graph-list')).toContainText('学 《A/B 测试》 之前要先懂 《p 值》')
  await page.getByRole('tab', { name: '图', exact: true }).click()
  // 笔记底部的关联面板里也能看到并修改类型
  await panel.getByRole('button', { name: '打开' }).click()
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('A/B 测试')
  const linked = page.getByTestId('connections').locator('[data-linked="p 值"]')
  await expect(linked.getByRole('combobox')).toHaveValue('prerequisite|1')
  await linked.getByRole('combobox').selectOption('contrasts|0')
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.graph.data())).edges.find((e) => e.relation === 'contrasts')?.relation)
    .toBe('contrasts')
})
