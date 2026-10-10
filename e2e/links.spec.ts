import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'

// 双向链接（v0.5.0）：[[ 链接、反向链接、未链接的提及、手动关联（双向）、相关推荐（需要向量模型，JIWEI_EVAL=1 时测试）。
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
const shots = process.env.SHOTS_DIR
const ids: Record<string, string> = {}

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-links-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

async function newNote(title: string, body: string): Promise<string> {
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill(title)
  await page.keyboard.press('Enter')
  await page.keyboard.type(body)
  await expect.poll(() => page.evaluate((t) => window.jiwei.notes.list({ search: t }).then((n) => n.filter((x) => x.title === t).length), title)).toBe(1)
  return page.evaluate((t) => window.jiwei.notes.list({ search: t }).then((n) => n.find((x) => x.title === t)!.id), title)
}

const connections = (id: string) => page.evaluate((id) => window.jiwei.connections.get(id), id)

test('[[ links to a note; the target shows a backlink', async () => {
  ids.mu = await newNote('边际效用', '每多消费一单位商品，带来的额外满足感逐渐减少。')
  ids.demand = await newNote('需求曲线', '需求曲线向下倾斜，原因是')
  await page.keyboard.type('[[边际')
  const picker = page.getByRole('listbox', { name: '链接到笔记或资料' })
  await expect(picker.getByRole('option', { name: /边际效用/ })).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, '161-link-picker.png') })
  await page.keyboard.press('Enter')
  await expect(page.locator(`.cornell-doc a[href="jiwei://note/${ids.mu}"]`)).toHaveText('边际效用')
  await page.keyboard.type('递减。')
  // 接着输入的文字不并进链接，也不多出空格
  await expect(page.locator(`.cornell-doc a[href="jiwei://note/${ids.mu}"]`)).toHaveText('边际效用')
  await expect(page.locator('.cornell-doc')).toContainText('原因是边际效用递减。')
  await expect.poll(async () => (await connections(ids.mu)).backlinks.map((b) => b.title), { timeout: 10_000 }).toContain('需求曲线')
  const b = (await connections(ids.mu)).backlinks[0]
  expect(b.text).toContain('需求曲线向下倾斜')

  // 在“边际效用”底部看到反向链接，点击回到“需求曲线”
  await page.locator(`.cornell-doc a[href="jiwei://note/${ids.mu}"]`).click()
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('边际效用')
  const panel = page.getByTestId('connections')
  await expect(panel.locator('[data-backlink="需求曲线"]')).toContainText('需求曲线向下倾斜')
  if (shots) await page.screenshot({ path: join(shots, '162-backlinks.png') })
  await panel.locator('[data-backlink="需求曲线"]').click()
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('需求曲线')
})

test('[[ can create a new note and link to it', async () => {
  await page.locator('.cornell-doc .cornell-body').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' 另见[[机会成本')
  await page.getByRole('option', { name: '新建笔记「机会成本」并链接' }).click()
  await expect(page.locator('.cornell-doc a', { hasText: '机会成本' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '机会成本' }).then((n) => n.some((x) => x.title === '机会成本')))).toBe(true)
})

test('unlinked mentions and two-way connections', async () => {
  ids.food = await newNote('吃包子的观察', '吃到第五个包子就没感觉了，这就是边际效用在起作用。')
  await expect.poll(async () => (await connections(ids.mu)).mentions.map((m) => m.title), { timeout: 10_000 }).toContain('吃包子的观察')
  // 在“边际效用”中关联它
  await page.evaluate((id) => window.jiwei.notes.get(id), ids.mu)
  await navTo(page, /^笔记/)
  if (await page.getByPlaceholder('笔记标题').count()) await navTo(page, /^笔记/)
  await page.getByText('边际效用', { exact: true }).first().click()
  const panel = page.getByTestId('connections')
  await panel.locator('[data-mention="吃包子的观察"]').getByRole('button', { name: '关联' }).click()
  await expect(panel.locator('[data-linked="吃包子的观察"]')).toBeVisible()
  await expect(panel.locator('[data-mention="吃包子的观察"]')).toHaveCount(0)
  // 双向：对方也能看到
  expect((await connections(ids.food)).linked.map((l) => l.title)).toContain('边际效用')
  // 取消关联 → 不再作为提及推荐
  await panel.locator('[data-linked="吃包子的观察"]').hover()
  await panel.getByRole('button', { name: '取消关联：吃包子的观察' }).click()
  await expect(panel.locator('[data-linked="吃包子的观察"]')).toHaveCount(0)
  const after = await connections(ids.mu)
  expect(after.linked).toHaveLength(0)
  expect(after.mentions.map((m) => m.title)).not.toContain('吃包子的观察')
})

test('turn a mention into a link inside the other note (undoable)', async () => {
  ids.econ = await newNote('经济学读书笔记', '这一章讲到需求曲线和价格的关系，还有弹性。')
  await expect.poll(async () => (await connections(ids.demand)).mentions.map((m) => m.title), { timeout: 10_000 }).toContain('经济学读书笔记')
  // 打开“需求曲线”，把提及变成链接（不用打开那篇笔记）
  await navTo(page, /^笔记/)
  if (await page.getByPlaceholder('笔记标题').count()) await navTo(page, /^笔记/)
  await page.getByText('需求曲线', { exact: true }).first().click()
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('需求曲线')
  const panel = page.getByTestId('connections')
  await panel.locator('[data-mention="经济学读书笔记"]').getByRole('button', { name: '变成链接' }).click()
  // 成为反向链接，不再是“提及”
  await expect(panel.locator('[data-backlink="经济学读书笔记"]')).toBeVisible({ timeout: 10_000 })
  await expect(panel.locator('[data-mention="经济学读书笔记"]')).toHaveCount(0)
  // 那篇笔记的正文里确实有了链接，其余文字不变
  await panel.locator('[data-backlink="经济学读书笔记"]').click()
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('经济学读书笔记')
  await expect(page.locator(`.cornell-doc a[href="jiwei://note/${ids.demand}"]`)).toHaveText('需求曲线')
  await expect(page.locator('.cornell-doc')).toContainText('这一章讲到需求曲线和价格的关系，还有弹性。')
  // 撤销：去掉链接
  const block = (await page.evaluate((id) => window.jiwei.notes.blocks(id), ids.econ)).find((b) => b.text.includes('需求曲线'))!
  await page.evaluate(({ a, b, blk }) => window.jiwei.connections.linkMention(a, b, blk, true), { a: ids.demand, b: ids.econ, blk: block.id })
  await expect.poll(async () => (await connections(ids.demand)).backlinks.map((x) => x.title), { timeout: 10_000 }).not.toContain('经济学读书笔记')
})

test('related notes by content (local vectors)', async () => {
  test.skip(!process.env.JIWEI_EVAL, '需要本地向量模型（JIWEI_EVAL=1）')
  test.setTimeout(300_000)
  await page.evaluate(() => window.jiwei.embedding.installLocal())
  ids.cost = await newNote('边际成本', '多生产一单位产品所增加的总成本叫边际成本，利润最大化时边际收益等于边际成本。')
  ids.py = await newNote('Python 列表', '列表可变，可以增删改；元组不可变。')
  await expect
    .poll(async () => {
      const s = await page.evaluate(() => window.jiwei.embedding.status())
      return s.state === 'ready' && s.total > 0 && s.indexed === s.total
    }, { timeout: 240_000, intervals: [2000] })
    .toBe(true)
  const rel = (await connections(ids.cost)).related.map((r) => r.title)
  console.log('related to 边际成本:', rel)
  expect(rel.slice(0, 3)).toContain('边际效用')
  expect(rel[0]).not.toBe('Python 列表')
})
