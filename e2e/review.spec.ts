import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'

// 复习（不需要 API Key）：线索自动成卡、FSRS 评分与间隔、撤销、不复习的笔记、设置。
// 设置 JIWEI_IMPORT_PROVIDERS_FROM 时额外测试“AI 检查我的回答”。
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let noteId = ''
const shots = process.env.SHOTS_DIR
const live = !!process.env.JIWEI_IMPORT_PROVIDERS_FROM

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-review-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', ...(live ? {} : { JIWEI_IMPORT_PROVIDERS_FROM: '' }) }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const row = (cue: string, body: string) => ({ op: 'insert_row' as const, afterRowId: null, cue: cue ? [p(cue)] : [], body: [p(body)] })

test('cue questions become review cards', async () => {
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('记忆方法')
  await page.keyboard.press('Enter')
  await page.keyboard.type('开头')
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '记忆方法' }).then((n) => n.length))).toBeGreaterThan(0)
  noteId = await page.evaluate(() => window.jiwei.notes.list({ search: '记忆方法' }).then((n) => n[0].id))
  await page.evaluate(
    ({ noteId, ops }) => window.jiwei.proposals.create({ noteId, title: '整理', ops }),
    {
      noteId,
      ops: [
        row('什么是间隔重复？', '在快要遗忘的时候复习，间隔逐渐拉长。'),
        row('提取练习为什么有效？', '主动回忆会加强记忆的提取通路，比重读更有效。'),
        row('', '没有线索的一行不会成为卡片。')
      ]
    }
  )
  await page.getByRole('button', { name: '全部接受' }).click()
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.review.stats())).total, { timeout: 15_000 }).toBe(2)
  // 导航徽标与首页入口
  await expect(page.getByTestId('nav-group-learn')).toContainText('2')
  await navTo(page, /^笔记/)
  await navTo(page, /^笔记/)
  await expect(page.getByTestId('home-review')).toContainText('2 张卡片待复习')
})

test('review session: reveal, rate with intervals, again, undo, done', async () => {
  await page.getByTestId('home-review').click()
  const card = page.getByTestId('review-card')
  await expect(page.getByTestId('review-question')).toHaveText('什么是间隔重复？')
  await expect(card).toContainText('新卡片')
  if (shots) await page.screenshot({ path: join(shots, '121-review-question.png') })
  await page.keyboard.press('Space')
  await expect(page.getByTestId('review-answer')).toContainText('在快要遗忘的时候复习')
  // 评分按钮显示下次间隔
  const group = page.getByRole('group', { name: '评分' })
  await expect(group.getByRole('button', { name: /忘了/ })).toContainText('分钟')
  await expect(group.getByRole('button', { name: /轻松/ })).toContainText('天')
  if (shots) await page.screenshot({ path: join(shots, '122-review-answer.png') })
  await page.keyboard.press('4')

  // 第二张：忘了 → 稍后再来一次
  await expect(page.getByTestId('review-question')).toHaveText('提取练习为什么有效？')
  await page.getByRole('button', { name: '显示答案' }).click()
  await page.keyboard.press('1')
  await expect(page.getByTestId('review-question')).toHaveText('提取练习为什么有效？')
  await expect(card).toContainText('学习中')
  // 撤销上一次评分：回到新卡片
  await page.getByRole('button', { name: '撤销' }).click()
  await expect(card).toContainText('新卡片')
  await page.keyboard.press('Space')
  await page.keyboard.press('4')

  await expect(page.getByTestId('review-done')).toBeVisible()
  await expect(page.getByTestId('review-done')).toContainText('这次复习了 2 张')
  if (shots) await page.screenshot({ path: join(shots, '123-review-done.png') })
  const stats = await page.evaluate(() => window.jiwei.review.stats())
  expect(stats.reviewedToday).toBe(2)
  expect(stats.streak).toBe(1)
  expect(stats.due).toBe(0)
  await expect(page.getByTestId('nav-group-learn')).not.toContainText('2')
})

test('editing a cue keeps the card; removing it removes the card; excluding the note hides its cards', async () => {
  const cards = await page.evaluate((id) => window.jiwei.review.forNote(id), noteId)
  expect(cards).toHaveLength(2)
  // 不复习这篇笔记
  await page.evaluate((id) => window.jiwei.notes.update(id, { reviewExcluded: true }), noteId)
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.review.stats())).total).toBe(0)
  await page.evaluate((id) => window.jiwei.notes.update(id, { reviewExcluded: false }), noteId)
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.review.stats())).total).toBe(2)
  // 进度保留：两张都已复习过
  const again = await page.evaluate((id) => window.jiwei.review.forNote(id), noteId)
  expect(again.every((c) => c.state === 'review')).toBe(true)

  // 修改线索：同一张卡片，进度保留；删除整行：卡片随之移除
  await navTo(page, /^笔记/)
  await page.getByText('记忆方法', { exact: true }).first().click()
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('记忆方法')
  const blocks = await page.evaluate((id) => window.jiwei.notes.blocks(id), noteId)
  const cue = blocks.find((b) => b.section === 'cue' && b.text === '什么是间隔重复？')!
  const row2 = blocks.find((b) => b.section === 'row' && b.text.startsWith('提取练习'))!
  await page.evaluate(
    ({ noteId, cueId, rowId }) =>
      window.jiwei.proposals.create({
        noteId,
        title: '修改',
        ops: [
          { op: 'replace_block', blockId: cueId, nodes: [{ type: 'paragraph', content: [{ type: 'text', text: '间隔重复是什么？怎么安排间隔？' }] }] },
          { op: 'delete_block', blockId: rowId }
        ]
      }),
    { noteId, cueId: cue.id, rowId: row2.id }
  )
  // 替换 / 删除以行内差异显示，逐条接受
  const diffs = page.getByRole('group', { name: /AI 建议/ })
  await expect(diffs).toHaveCount(2)
  await diffs.first().getByRole('button', { name: '接受' }).click()
  await expect(diffs).toHaveCount(1)
  await diffs.first().getByRole('button', { name: '接受' }).click()
  await expect(diffs).toHaveCount(0)
  await expect.poll(async () => (await page.evaluate((id) => window.jiwei.review.forNote(id), noteId)).length, { timeout: 15_000 }).toBe(1)
  const left = await page.evaluate((id) => window.jiwei.review.forNote(id), noteId)
  expect(left[0].id).toBe(again.find((c) => c.rowId === cue.rowId)!.id)
  expect(left[0].state).toBe('review')
  const c = await page.evaluate((id) => window.jiwei.review.get(id), left[0].id)
  expect(c!.question).toBe('间隔重复是什么？怎么安排间隔？')
})

test('settings: new cards per day and target retention', async () => {
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('dialog').getByRole('button', { name: '学习', exact: true }).click()
  await page.getByRole('button', { name: '10', exact: true }).click()
  await page.getByRole('button', { name: '95%', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.settings.get())).review).toEqual({ newPerDay: 10, retention: 0.95 })
  await page.keyboard.press('Escape')
})

test('AI checks a typed answer against the note (live)', async () => {
  test.skip(!live, '需要 JIWEI_IMPORT_PROVIDERS_FROM')
  test.setTimeout(120_000)
  await page.evaluate(
    ({ noteId, ops }) => window.jiwei.proposals.create({ noteId, title: '补充', ops }),
    { noteId, ops: [row('费曼技巧的四个步骤？', '1. 选一个概念；2. 讲给外行听；3. 卡住处回到资料；4. 简化并用类比。')] }
  )
  // 回到这篇笔记（当前可能停在首页）
  await navTo(page, /^笔记/)
  if (!(await page.getByPlaceholder('笔记标题').count())) await page.getByText('记忆方法', { exact: true }).first().click()
  await page.getByRole('button', { name: '全部接受' }).click()
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.review.stats())).due, { timeout: 15_000 }).toBe(1)
  await navTo(page, /^复习/)
  await expect(page.getByTestId('review-question')).toHaveText('费曼技巧的四个步骤？')
  await page.getByRole('textbox').fill('先选一个概念，然后讲给别人听。')
  await page.getByRole('button', { name: 'AI 检查我的回答' }).click()
  const check = page.getByTestId('answer-check')
  await expect(check).toBeVisible({ timeout: 90_000 })
  await expect(check).toContainText('遗漏')
  if (shots) await page.screenshot({ path: join(shots, '124-review-check.png') })
  // 只答出一半：建议“忘了”或“困难”
  const suggested = page.locator('[data-suggested="true"]')
  await expect(suggested).toHaveCount(1)
  await expect(suggested).toContainText(/忘了|困难/)
})
