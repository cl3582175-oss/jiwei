import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// 费曼练习：入口与界面（不需要 API Key）；设置 JIWEI_IMPORT_PROVIDERS_FROM 时测试真实的追问与诊断。
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
const shots = process.env.SHOTS_DIR
const live = !!process.env.JIWEI_IMPORT_PROVIDERS_FROM

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-feynman-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', ...(live ? {} : { JIWEI_IMPORT_PROVIDERS_FROM: '' }) }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

test('start from the command palette; back returns', async () => {
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('机会成本')
  await page.getByRole('option', { name: /费曼练习：把「机会成本」讲给 AI 听/ }).click()
  await expect(page.getByRole('heading', { name: '把「机会成本」讲给小微听' })).toBeVisible()
  await expect(page.getByTestId('feynman-opener')).toContainText('机会成本')
  await expect(page.getByRole('button', { name: '我讲完了，看看哪里没讲清楚' })).toBeDisabled()
  if (shots) await page.screenshot({ path: join(shots, '131-feynman-start.png') })
  await page.getByRole('button', { name: '后退' }).first().click()
  await expect(page.getByRole('heading', { name: '把「机会成本」讲给小微听' })).toHaveCount(0)
})

test('explain to the student, get diagnosed, add gaps to the note (live)', async () => {
  test.skip(!live, '需要 JIWEI_IMPORT_PROVIDERS_FROM')
  test.setTimeout(400_000)
  // 一篇笔记，一张复习卡片
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('经济学笔记')
  await page.keyboard.press('Enter')
  await page.keyboard.type('开头')
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '经济学笔记' }).then((n) => n.length))).toBeGreaterThan(0)
  const noteId = await page.evaluate(() => window.jiwei.notes.list({ search: '经济学笔记' }).then((n) => n[0].id))
  const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
  await page.evaluate(
    ({ noteId, cue, body }) =>
      window.jiwei.proposals.create({ noteId, title: '整理', ops: [{ op: 'insert_row', afterRowId: null, cue: [cue], body: [body] }] }),
    {
      noteId,
      cue: p('什么是边际效用递减？'),
      body: p(
        '每多消费一单位商品，带来的额外满足感（边际效用）逐渐减少。例如饿的时候第一个包子最香，第五个就没那么想吃了。它解释了为什么需求曲线向下倾斜：越往后，人们愿意为多一单位支付的价格越低。'
      )
    }
  )
  await page.getByRole('button', { name: '全部接受' }).click()
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.review.stats())).total, { timeout: 15_000 }).toBe(1)

  // 从复习卡片进入
  await page.getByRole('button', { name: /^复习/ }).click()
  // 点按钮显示答案（按空格时，若回答框已获得焦点，空格会输入进框里）
  await page.getByRole('button', { name: /显示答案/ }).click()
  await page.getByRole('button', { name: '用自己的话讲一遍' }).click()
  await expect(page.getByRole('heading', { name: '把「什么是边际效用递减？」讲给小微听' })).toBeVisible()

  const box = page.getByRole('textbox', { name: /用你自己的话讲/ })
  const waitReply = async (n: number): Promise<string> => {
    const items = page.locator('.group\\/msg')
    await expect(items).toHaveCount(n, { timeout: 30_000 })
    const last = items.last()
    await expect(last.getByRole('button', { name: '复制' })).toBeVisible({ timeout: 120_000 })
    return (await last.innerText()).trim()
  }
  await box.fill('边际效用递减就是东西越多越不值钱，比如包子吃多了，包子就变便宜了。')
  await page.keyboard.press('Enter')
  const r1 = await waitReply(1)
  console.log('student 1:', r1)
  // 学生：追问（一个问题），简短，不讲课
  expect(r1).toMatch(/[？?]/)
  expect(r1.length).toBeLessThan(400)
  await box.fill('哦我说得不对。不是包子变便宜，是你每多吃一个包子，多得到的那份满足感比上一个少。第一个最满足，第五个就没什么感觉了。')
  await page.keyboard.press('Enter')
  const r2 = await waitReply(2)
  console.log('student 2:', r2)

  await page.getByRole('button', { name: '我讲完了，看看哪里没讲清楚' }).click()
  const report = page.getByTestId('feynman-report')
  await expect(report).toBeVisible({ timeout: 120_000 })
  console.log('report:', (await report.innerText()).replace(/\s+/g, ' ').slice(0, 800))
  // 漏掉了“需求曲线向下倾斜”，第一次还说错了
  await expect(report).toContainText(/还没讲清楚|需要更正/)
  await expect(report.getByRole('checkbox').first()).toBeChecked()
  if (shots) {
    await report.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(shots, '132-feynman-report.png') })
  }
  const before = (await page.evaluate(() => window.jiwei.review.stats())).total
  await report.getByRole('button', { name: /加入笔记/ }).click()
  await report.getByRole('button', { name: '打开笔记' }).click()
  // 补进笔记的问题自动应用，并成为新的复习卡片
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.review.stats())).total, { timeout: 20_000 }).toBeGreaterThan(before)
})
