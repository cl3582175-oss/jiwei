import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'

// v0.7.6 真实环境验收：真实 DeepSeek 在资料较长、范围不明时先查看规模并用选择题问范围；
// 选“整份资料”后确认费用，后台分批整理成康奈尔提纲并作为提案进笔记；回答下方的依据默认折叠。
// 运行：JIWEI_IMPORT_PROVIDERS_FROM=<应用数据库> npx playwright test e2e/v076-live.spec.ts
const source = process.env.JIWEI_IMPORT_PROVIDERS_FROM
test.skip(!source, '需要 JIWEI_IMPORT_PROVIDERS_FROM（真实服务商配置）')
test.describe.configure({ mode: 'serial' })
test.setTimeout(400_000)

let app: ElectronApplication, page: Page
const out = process.env.SHOTS_DIR
const record: Record<string, unknown> = {}
const shot = async (name: string): Promise<void> => {
  if (out) await page.screenshot({ path: join(out, `${name}.png`) })
}

const CHAPTERS = [
  ['第一章 遗忘规律', '艾宾浩斯发现，学习后的头几天遗忘最快，之后逐渐变慢。遗忘不是坏事：它让复习时的提取更费力，从而记得更牢。'],
  ['第二章 间隔重复', '把复习安排在快要遗忘的时候，间隔逐次拉长。FSRS 等算法根据每张卡片的稳定性与难度预测最佳复习时间。'],
  ['第三章 提取练习', '主动回忆比重读更有效。合上书写出要点、做题自测，都是提取练习；即使答错，只要随后看答案也能加强记忆。'],
  ['第四章 交错练习', '把不同类型的题目混在一起练，迫使大脑先判断用哪种方法，比集中练同一类题更能迁移到考试中。'],
  ['第五章 精细加工', '用自己的话解释、举例、和已知联系起来，问“为什么”和“怎么做”，能把新知识织进已有的知识网。']
]

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-v076-live-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await expect.poll(() => page.evaluate(() => window.jiwei.providers.list().then((p) => p.some((x) => x.hasKey)))).toBe(true)
  // 一份五章、每章 14 段的资料（共 70 余段）：较长，应当先问范围
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-v076-live-src-'))
  const file = join(dir, '学习科学讲义.md')
  writeFileSync(
    file,
    [
      '# 学习科学讲义',
      ...CHAPTERS.flatMap(([h, body]) => [
        `## ${h}`,
        ...Array.from({ length: 14 }, (_, i) => `${body}（${h.slice(0, 3)}第 ${i + 1} 段：结合例子 ${i + 1} 说明。）`)
      ])
    ].join('\n\n')
  )
  await page.evaluate((f) => window.jiwei.sources.importPaths([f]), file)
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const s = (await window.jiwei.sources.list({})).find((x) => x.title.includes('学习科学讲义'))
          return s ? (await window.jiwei.sources.indexStatus(s.id)).segments : 0
        }),
      { timeout: 30_000 }
    )
    .toBeGreaterThan(60)
})
test.afterAll(async () => {
  if (out) {
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'v076-live.json'), JSON.stringify(record, null, 2))
  }
  await app?.close()
})

test('真实 DeepSeek：请求含糊（“帮我画个思维导图”）时先看规模、用选择题问范围；选整份资料后确认费用，后台整理成导图进笔记', async () => {
  await navTo(page, /资料库/)
  await page.getByText('学习科学讲义', { exact: true }).first().dblclick()
  await expect(page.getByTestId('source-start')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+j')
  const box = page.getByRole('complementary', { name: '积微助手' }).getByRole('textbox').last()
  await box.fill('帮我画个思维导图')
  await box.press('Enter')
  const choices = page.getByTestId('ask-choices')
  await expect(choices).toBeVisible({ timeout: 180_000 })
  record.options = await choices.getByRole('button').allInnerTexts()
  await shot('v076-live-choices')
  await choices
    .getByRole('button', { name: /整份|全部|整本|全书|全文/ })
    .first()
    .click()
  const allow = page.getByRole('button', { name: '允许' }).last()
  await expect(allow).toBeVisible({ timeout: 180_000 })
  record.confirm = await page
    .getByText(/分 \d+ 批读取/)
    .first()
    .innerText()
  await shot('v076-live-confirm')
  await allow.click()
  await expect(page.getByText(/已做好，作为提案放进了笔记/)).toBeVisible({ timeout: 300_000 })
  await page.getByRole('button', { name: '打开笔记' }).last().click()
  await expect(page.getByRole('button', { name: '全部接受' })).toBeVisible({ timeout: 20_000 })
  record.mindmapNote = await page.getByPlaceholder('笔记标题').inputValue()
  await shot('v076-live-proposal')
})

test('真实 DeepSeek：起始页选好一章后直接起草，只用这一章的内容', async () => {
  await navTo(page, /资料库/)
  await page.getByText('学习科学讲义', { exact: true }).first().dblclick()
  // 上一项打开的浮动助手面板会盖住起始页：先关掉
  const panel = page.getByRole('complementary', { name: '积微助手' })
  if (await panel.count()) await panel.getByRole('button', { name: '关闭' }).click()
  await page.getByTestId('source-start').getByRole('button', { name: '让 AI 起草提纲' }).click()
  const listProposals = () =>
    page.evaluate(async () => {
      const notes = await window.jiwei.notes.list({})
      return (
        await Promise.all(
          notes.map((n) =>
            window.jiwei.proposals
              .list(n.id)
              .then((ps) => ps.map((p) => ({ id: p.id, note: n.title, title: p.title, text: JSON.stringify(p.ops).slice(0, 4000) })))
          )
        )
      ).flat()
    })
  const before = new Set((await listProposals()).map((p) => p.id))
  const scope = page.getByTestId('draft-scope')
  await scope.getByRole('button', { name: /第二章 间隔重复/ }).click()
  // 直接发出；新建笔记要用户确认
  const allow = page.getByRole('button', { name: '允许' }).last()
  await expect(allow).toBeVisible({ timeout: 240_000 })
  await allow.click()
  // 新笔记（直接写入，或作为提案）标题含第二章，内容来自这一章
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.notes.list({ search: '第二章' }))).length, { timeout: 240_000 })
    .toBeGreaterThan(0)
  const note = (await page.evaluate(() => window.jiwei.notes.list({ search: '第二章' })))[0]
  const fresh = (await listProposals()).filter((p) => !before.has(p.id))
  record.chapterNote = { title: note.title, excerpt: note.excerpt, proposals: fresh.map((p) => p.title) }
  expect(note.title).toMatch(/第二章|间隔重复/)
  expect(`${note.excerpt} ${fresh.map((p) => p.text).join(' ')}`).toMatch(/间隔|复习|FSRS/)
  await shot('v076-live-chapter')
})

test('真实 DeepSeek：回答下方的依据默认折叠，展开后列出片段与来源方式', async () => {
  await navTo(page, /积微助手/)
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await page.getByRole('textbox', { name: '问积微，或交代一件事……' }).fill('交错练习为什么比集中练习更有效？请用我的资料回答。')
  await page.keyboard.press('Enter')
  const basis = page.getByTestId('answer-basis').last()
  await expect(basis).toContainText(/依据 · 知识库/, { timeout: 180_000 })
  record.basis = await basis.innerText()
  await basis.getByRole('button', { name: '展开依据' }).click()
  await expect(basis.getByText('学习科学讲义').first()).toBeVisible()
  await shot('v076-live-basis')
})
