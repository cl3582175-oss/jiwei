import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, type Server } from 'http'
import { navTo } from './fixtures/nav'

// v0.9 参谋与决策日志：知识库依据 → 备忘录（受控模型）→ 调权重 → 记录决定 → 到期提醒 → 回看并生成教训卡片。
test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page, server: Server
const prompts: string[] = []
const shots = process.env.SHOTS_DIR

const memo = (sources: string[]) => ({
  restated: '在下学期去实习和留校专心备考之间做选择',
  options: [
    { id: 'O1', title: '去实习', summary: '积累项目经验，但备考时间减少一半' },
    { id: 'O2', title: '专心备考', summary: '时间充足，但简历上缺少实践经历' },
    { id: 'O3', title: '编造的选项', summary: '用来检验重复编号被去掉' },
    { id: 'O3', title: '重复编号', summary: '应被去掉' }
  ],
  criteria: [
    { name: '长期收益', weight: 5, why: '' },
    { name: '时间压力', weight: 3, why: '' }
  ],
  scores: [
    { option: 'O1', criterion: '长期收益', score: 5, why: '' },
    { option: 'O1', criterion: '时间压力', score: 2, why: '' },
    { option: 'O2', criterion: '长期收益', score: 3, why: '' },
    { option: 'O2', criterion: '时间压力', score: 5, why: '' },
    { option: 'O9', criterion: '长期收益', score: 5, why: '不存在的选项' }
  ],
  evidence: [
    ...sources.slice(0, 1).map((s) => ({ source: s, claim: '你的笔记里记着：实习能把课上学的东西用起来' })),
    { source: 'S99', claim: '编造的依据，应被丢弃' }
  ],
  assumptions: ['实习单位能给到真实的项目'],
  premortem: ['实习占用太多时间，考试准备不足'],
  secondOrder: ['实习经历会影响研究生面试的话题'],
  counter: '备考是一次性的窗口，实习以后还有机会。',
  risks: [{ risk: '两头都做不好', mitigation: '和实习单位约定每周最多三天' }],
  recommendation: { option: 'O1', why: '长期收益更高，时间压力可以通过约定工作日来缓解' },
  confidence: 3,
  unknowns: ['实习单位是否允许弹性工作']
})

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const input = JSON.parse(body)
      const text = (c: unknown): string =>
        typeof c === 'string' ? c : Array.isArray(c) ? c.map((v: { text?: string }) => v.text ?? '').join('') : ''
      const prompt = text(input.messages.filter((m: { role: string }) => m.role === 'user').at(-1)?.content)
      prompts.push(prompt)
      const ids = [...prompt.matchAll(/"id":"(S\d+)"/g)].map((m) => m[1])
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'controlled',
          object: 'chat.completion',
          created: 1,
          model: 'deepseek-flash',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'submit', type: 'function', function: { name: 'submit', arguments: JSON.stringify(memo(ids)) } }]
              },
              finish_reason: 'tool_calls'
            }
          ],
          usage: { prompt_tokens: 3000, completion_tokens: 900, total_tokens: 3900 }
        })
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-advisor-'))}`],
    env: { ...process.env, JIWEI_TEST_NETWORK: '1', JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const ids = await page.evaluate(async (baseUrl) => {
    const j = window.jiwei
    const provider = await j.providers.save({ kind: 'ollama', name: '受控参谋模型', baseUrl, models: ['deepseek-flash'] } as never)
    const s = await j.settings.get()
    await j.settings.set({ ai: { ...s.ai, chat: { providerId: provider.id, model: 'deepseek-flash' }, effort: 'off' } } as never)
    // 知识库依据：一篇允许给 AI 的笔记、一篇不给 AI 的笔记
    const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
    const ok = await j.notes.create({ title: '实习经验' })
    await j.proposals.create({
      noteId: ok.id,
      title: 'x',
      ops: [{ op: 'insert_row', afterRowId: null, cue: [p('实习的价值')], body: [p('实习能把课上学的东西用起来，备考时间会被压缩')] }]
    } as never)
    const secret = await j.notes.create({ title: '私密日记' })
    await j.proposals.create({
      noteId: secret.id,
      title: 'x',
      ops: [{ op: 'insert_row', afterRowId: null, cue: [p('实习 私密')], body: [p('私密内容：实习备考的真实想法')] }]
    } as never)
    return { ok: ok.id, secret: secret.id }
  }, baseUrl)
  await page.reload()
  await page.waitForSelector('nav')
  // 打开两篇笔记接受内容，再把私密日记设为不给 AI；等关键词索引建好
  for (const title of ['实习经验', '私密日记']) {
    await navTo(page, /^笔记/, { again: true })
    await page.locator('[data-note-id]').filter({ hasText: title }).first().click()
    await page.getByRole('button', { name: '全部接受' }).click()
    await page.waitForTimeout(300)
  }
  await page.evaluate((id) => window.jiwei.notes.update(id, { aiExcluded: true } as never), ids.secret)
  await expect
    .poll(() => page.evaluate(() => window.jiwei.knowledge.search('实习', { type: 'all' }).then((h) => h.map((x) => x.title).join(','))), {
      timeout: 30_000
    })
    .toContain('实习经验')
})
test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((r) => server.close(() => r()))
})

test('提问生成备忘录：依据来自知识库且不含不给 AI 的内容，编造编号被去掉', async () => {
  await page.getByTestId('nav-rail').getByRole('button', { name: /^创作/ }).click()
  await expect(page.getByTestId('advisor-view')).toBeVisible()
  await page.getByRole('textbox', { name: '参谋' }).fill('下学期要不要去实习？')
  await page.getByRole('button', { name: '补充背景（可选）' }).click()
  await page.getByRole('textbox', { name: '补充背景（可选）' }).fill('明年三月考试，最看重长期发展')
  if (shots) await page.screenshot({ path: join(shots, '201-advisor-home.png') })
  await page.getByRole('button', { name: '请参谋' }).click()
  const memoView = page.getByTestId('decision-memo')
  await expect(memoView).toBeVisible({ timeout: 30_000 })
  // 请求里有允许的依据、没有私密笔记
  const last = prompts.at(-1)!
  expect(last).toContain('实习能把课上学的东西用起来')
  expect(last).not.toContain('私密内容')
  expect(last).toContain('明年三月考试')
  // 重复编号、不存在的选项评分、编造的依据都被去掉
  await expect(memoView.locator('[data-option]')).toHaveCount(3)
  await expect(page.getByTestId('decision-evidence').locator('li')).toHaveCount(1)
  await expect(page.getByTestId('decision-evidence')).toContainText('实习经验')
  await expect(memoView).toContainText('参谋建议')
  await expect(memoView).toContainText('事前验尸')
  // 加权得分：O1 = (5/5*5 + 2/5*3)/8 = 77，O2 = (3/5*5 + 5/5*3)/8 = 75
  const totals = () => memoView.locator('[data-option]').evaluateAll((els) => els.map((e) => e.querySelector('.font-serif')?.textContent))
  expect((await totals()).slice(0, 2)).toEqual(['78', '75'])
  // 调高“时间压力”的权重，专心备考反超
  const row = page.getByTestId('decision-matrix').getByRole('group', { name: '时间压力' })
  await row.getByRole('button', { name: '+' }).click()
  await row.getByRole('button', { name: '+' }).click()
  await expect.poll(async () => (await totals()).slice(0, 2)).toEqual(['70', '80'])
  if (shots) await page.screenshot({ path: join(shots, '202-advisor-memo.png'), fullPage: true })
})

test('记录决定 → 到期在今日页提醒 → 回看并把教训写成复习卡片', async () => {
  await page.getByRole('button', { name: '记录我的决定' }).click()
  const dialog = page.getByTestId('decide-dialog')
  await expect(dialog.getByRole('radio', { name: /去实习/ })).toBeChecked()
  await dialog.getByRole('textbox', { name: '我的预期' }).fill('三个月后拿到一段完整项目经历，模拟考成绩不低于 110')
  await dialog.getByRole('button', { name: '2 周后' }).click()
  await dialog.getByRole('button', { name: '记下' }).click()
  await expect(page.getByTestId('decision-record')).toContainText('去实习')
  // 把回看日期改到过去，模拟到期
  const id = await page.evaluate(async () => {
    const [d] = await window.jiwei.advisor.list()
    await window.jiwei.advisor.decide({ id: d.id, choice: d.choice!, expectation: d.expectation!, reviewAt: Date.now() - 1000 })
    return d.id
  })
  await page.keyboard.press('ControlOrMeta+9')
  await expect(page.getByTestId('decisions-due')).toContainText('下学期要不要去实习')
  await page.getByTestId('decisions-due').getByRole('button', { name: '去回看' }).click()
  await expect(page.getByTestId('decision-page')).toBeVisible()
  await page.getByRole('button', { name: '现在回看' }).click()
  const review = page.getByTestId('review-decision-dialog')
  await review.getByRole('textbox', { name: '实际结果' }).fill('项目经历拿到了，但模拟考只有 98 分')
  await review.getByRole('button', { name: '部分准确' }).click()
  await review.getByRole('textbox', { name: '教训' }).fill('先和单位约定好每周的工作天数')
  await review.getByRole('button', { name: '记下' }).click()
  await expect(page.getByTestId('decision-record')).toContainText('部分准确')
  const d = await page.evaluate((id) => window.jiwei.advisor.get(id), id)
  expect(d).toMatchObject({ status: 'reviewed', accuracy: 3 })
  // 教训写入《决策教训》笔记
  const notes = await page.evaluate(() => window.jiwei.notes.list({ search: '决策教训' }))
  expect(notes.length).toBe(1)
  await page.keyboard.press('ControlOrMeta+9')
  await expect(page.getByTestId('decisions-due')).toHaveCount(0)
})
