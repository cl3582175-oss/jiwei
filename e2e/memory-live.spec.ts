import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChatSend } from '../src/shared/schemas'

// 记忆 v2（真实模型）：对话后自动整理（记忆、概念掌握度、学习经历）、选区解释记录学习信号、从用户修改中归纳技能偏好。
const source = process.env.JIWEI_IMPORT_PROVIDERS_FROM
test.skip(!source, '需要 JIWEI_IMPORT_PROVIDERS_FROM（真实服务商配置）')
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let providerId = ''
let model = ''
const shots = process.env.SHOTS_DIR

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-memv2-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_MEMORY_DELAY_MS: '2000' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  const s = await page.evaluate(() => window.jiwei.settings.get())
  providerId = s.ai.chat.providerId!
  model = s.ai.chat.model!
})
test.afterAll(async () => {
  await app?.close()
})

async function send(text: string, opts: Partial<ChatSend> = {}): Promise<string> {
  const r = await page.evaluate((inp) => window.jiwei.chat.send(inp as never), {
    conversationId: null,
    providerId,
    model,
    effort: 'off',
    scope: { type: 'none' },
    text,
    ...opts
  })
  await expect
    .poll(
      async () => (await page.evaluate((cid) => window.jiwei.chat.messages(cid), r.conversation.id)).find((m) => m.id === r.assistantMessageId)?.status,
      { timeout: 180_000, intervals: [1000] }
    )
    .toBe('done')
  return r.conversation.id
}

test('learns memories, concept signals and a study log after a conversation', async () => {
  test.setTimeout(300_000)
  const convId = await send(
    '我是一名产品经理，最近在自学统计学，准备自己做 A/B 测试分析。p 值我一直没搞懂，看了好几遍还是不明白它到底表示什么，能讲讲吗？'
  )
  // 对话安静 2 秒后，后台自动整理（不进后台任务列表）
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.memory.list({ kind: 'episode' }))).length, { timeout: 120_000, intervals: [2000] })
    .toBeGreaterThan(0)
  const memories = await page.evaluate(() => window.jiwei.memory.list({}))
  const facts = memories.filter((m) => m.origin === 'ai' && m.kind !== 'episode').map((m) => m.content)
  console.log('learned:', facts, memories.find((m) => m.kind === 'episode')?.content)
  expect(facts.join('\n')).toMatch(/产品经理|统计|A\/B/)
  // 概念懂不懂只进学习者模型，不重复成记忆
  expect(facts.join('\n')).not.toMatch(/p\s*值/)
  const episode = memories.find((m) => m.kind === 'episode')!
  expect(episode.evidence?.conversationId).toBe(convId)
  // 学习者模型：p 值“没弄懂”
  const concepts = await page.evaluate(() => window.jiwei.memory.concepts())
  console.log('concepts:', concepts.map((c) => `${c.name} ${c.level} a${c.asked} c${c.confused} u${c.understood}`))
  const p = concepts.find((c) => /p\s*值|p-?value/i.test(c.name))
  expect(p).toBeTruthy()
  expect(p!.level).toBe('weak')
  // 后台整理不出现在后台任务里
  expect((await page.evaluate(() => window.jiwei.jobs.list())).some((j) => /记忆/.test(j.title))).toBe(false)
  // 再整理一次：没有新消息，不重复
  const again = await page.evaluate((id) => window.jiwei.memory.learnNow(id), convId)
  expect(again.added).toBe(0)
})

test('selecting a term and asking to explain records a learning signal immediately', async () => {
  test.setTimeout(200_000)
  const note = await page.evaluate(() => window.jiwei.notes.create({ title: '统计学笔记' }))
  const anchor = { kind: 'note-text' as const, parentType: 'note' as const, parentId: note.id, quote: '标准差' }
  await send('解释一下“标准差”', { skill: 'explain-concept', kind: 'inline', anchor, context: { targets: [anchor] } })
  const c = (await page.evaluate(() => window.jiwei.memory.concepts())).find((x) => x.name === '标准差')
  expect(c?.asked).toBeGreaterThanOrEqual(1)
  // 整理同一对话不会再算一次“请求解释”
  await page.waitForTimeout(4000)
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.memory.concepts())).find((x) => x.name === '标准差')?.asked, { timeout: 60_000 })
    .toBe(1)

  // 「关于我 · 学习情况」
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('dialog').getByRole('button', { name: '关于我', exact: true }).click()
  await page.getByRole('tab', { name: '学习情况' }).click()
  await expect(page.locator('[data-concept="标准差"]')).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, '111-progress.png') })
  await page.getByRole('tab', { name: '学习经历' }).click()
  await expect(page.locator('ol li').first()).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, '112-study-log.png') })
  await page.keyboard.press('Escape')
})

test('learns a skill preference from repeated user edits', async () => {
  test.setTimeout(300_000)
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('总结偏好')
  await page.keyboard.press('Enter')
  await page.keyboard.type('开头')
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '总结偏好' }).then((n) => n.length))).toBeGreaterThan(0)
  const noteId = await page.evaluate(() => window.jiwei.notes.list({ search: '总结偏好' }).then((n) => n[0].id))

  // AI 的总结都很啰嗦；用户每次都改成一句话
  const samples = [
    [
      '首先，我们需要认识到，间隔重复是一种非常重要且有效的学习方法，它的核心在于在即将遗忘的时候进行复习；其次，随着复习次数的增加，间隔会逐渐拉长；综上所述，间隔重复能够帮助我们用最少的时间记得最久。',
      '间隔重复：快忘时复习，间隔越拉越长。'
    ],
    [
      '首先，提取练习指的是主动回忆所学内容，而不是被动地重读材料；其次，大量研究表明这种方式的效果明显优于重读；综上所述，我们在学习中应该多做自测、多做回忆，而不是一遍遍地看书。',
      '提取练习：主动回忆比重读有效。'
    ],
    [
      '首先，交错练习是指把不同类型的题目混在一起练习，而不是一类题集中练完再换下一类；其次，这样做虽然当时感觉更难，但能提高辨别题型的能力；综上所述，交错练习有助于长期的迁移与应用。',
      '交错练习：混着练，更会辨别题型。'
    ]
  ]
  for (const [long, short] of samples) {
    await page.evaluate(
      ({ noteId, long }) =>
        window.jiwei.proposals.create({
          noteId,
          title: '总结',
          skill: 'summarize-note',
          ops: [{ op: 'insert_row', afterRowId: null, cue: [], body: [{ type: 'paragraph', content: [{ type: 'text', text: long }] }] }]
        }),
      { noteId, long }
    )
    await page.getByRole('button', { name: '全部接受' }).click()
    const para = page.locator('.cornell-doc p', { hasText: long.slice(0, 12) })
    await expect(para).toBeVisible()
    await para.click({ clickCount: 3 })
    await page.keyboard.type(short)
    await expect
      .poll(async () => JSON.stringify(await page.evaluate((id) => window.jiwei.notes.blocks(id), noteId)), { timeout: 15_000 })
      .toContain(short)
  }
  // 立即维护（正常是 AI 内容稳定 10 分钟后检查）
  const r = await page.evaluate(() => window.jiwei.memory.maintain({ force: true }))
  console.log('maintain:', r)
  expect(r.reviewed).toBe(3)
  const prefs = (await page.evaluate(() => window.jiwei.memory.list({ kind: 'skill' }))).filter((m) => m.skill === 'summarize-note')
  console.log('skill prefs:', prefs.map((m) => m.content))
  expect(prefs.length).toBeGreaterThan(0)
  const text = prefs.map((m) => m.content).join()
  expect(text).toMatch(/简|短|一句|单行|压缩|精炼|核心/)
  expect(text).not.toMatch(/三段式/)
})
