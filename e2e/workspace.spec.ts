import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// v0.1.2：资料分段（后台任务）→ 工作区双栏 → AI 提案（思维导图）→ 接受 → 展开为康奈尔行 → 来源标记 → 重启持久化
const userData = mkdtempSync(join(tmpdir(), 'jiwei-e2e-ws-'))
const shots = process.env.SHOTS_DIR
let app: ElectronApplication
let page: Page
let noteId = ''

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
}
const shot = async (name: string): Promise<void> => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}

test.describe.configure({ mode: 'serial' })
test.beforeAll(launch)
test.afterAll(async () => {
  await app?.close()
})

test('capability registry validates arguments', async () => {
  const err = await page.evaluate(() =>
    (window.jiwei.notes.get as unknown as (x: number) => Promise<unknown>)(123).then(
      () => 'ok',
      (e: Error) => e.message
    )
  )
  expect(err).toContain('Invalid argument "id"')
})

test('markdown source is segmented by a background job and opens in the workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-src-'))
  const file = join(dir, '学习科学.md')
  writeFileSync(file, '# 学习科学\n\n间隔重复：在即将遗忘时复习，记忆最牢固。\n\n## 提取练习\n\n主动回忆比反复阅读更有效。\n')
  await page.evaluate((p) => window.jiwei.sources.importPaths([p]), file)
  await page.getByRole('button', { name: /资料库/ }).click()
  await page.getByText('学习科学', { exact: true }).dblclick()
  // 工作区左栏显示分段后的正文
  await expect(page.locator('.source-text p').first()).toHaveText('间隔重复：在即将遗忘时复习，记忆最牢固。', { timeout: 10000 })
  await expect(page.locator('.source-text h3')).toHaveCount(2)
  const found = await page.evaluate(() => window.jiwei.segments.search('主动回忆'))
  expect(found.length).toBe(1)
})

test('note beside source: AI proposal with a mind map is previewed and accepted', async () => {
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('学习科学')
  await page.keyboard.press('Enter')
  await page.keyboard.type('我自己写的一句话。')
  await expect(page.locator('.source-text')).toBeVisible() // 资料仍在左侧
  // 标题防抖保存后可检索到
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '学习科学' }).then((n) => n.length))).toBeGreaterThan(0)
  noteId = await page.evaluate(() => window.jiwei.notes.list({ search: '学习科学' }).then((n) => n[0].id))

  // 模拟 AI：根据资料生成思维导图 + 一行笔记 + 补充总结（v0.2 起由真实模型调用同一能力）
  const segs = await page.evaluate(() => window.jiwei.segments.search('间隔重复'))
  await page.evaluate(
    ({ noteId, segId }) =>
      window.jiwei.proposals.create({
        noteId,
        title: '根据《学习科学》生成思维导图',
        model: 'deepseek-chat',
        sources: [{ type: 'segment', id: segId }],
        ops: [
          {
            op: 'insert_row',
            afterRowId: null,
            cue: [{ type: 'paragraph', content: [{ type: 'text', text: '学习科学的两大方法？' }] }],
            body: [{ type: 'embed', attrs: { id: 'mm1', kind: 'mindmap' } }]
          },
          { op: 'append_summary', nodes: [{ type: 'paragraph', content: [{ type: 'text', text: '间隔与提取是长期记忆的关键。' }] }] }
        ],
        embeds: {
          mm1: {
            kind: 'mindmap',
            data: {
              root: 'r',
              nodes: {
                r: { text: '学习科学', parent: null, order: 0 },
                a: { text: '间隔重复', parent: 'r', order: 0, anchor: { type: 'segment', id: segId } },
                a1: { text: '遗忘前复习', parent: 'a', order: 0 },
                b: { text: '提取练习', parent: 'r', order: 1 },
                b1: { text: '主动回忆', parent: 'b', order: 0 }
              }
            }
          }
        }
      }),
    { noteId, segId: segs[0].id }
  )
  await expect(page.getByText('根据《学习科学》生成思维导图')).toBeVisible()
  await expect(page.locator('.proposal-embed')).toContainText('提取练习')
  await shot('21-proposal')
  await page.getByRole('button', { name: '全部接受' }).click()

  await expect(page.locator('.cornell-row')).toHaveCount(2)
  await expect(page.locator('.embed-block[data-kind="mindmap"] svg.mindmap-svg')).toBeVisible()
  await expect(page.locator('.embed-block .embed-ai')).toHaveText(/AI 生成/)
  await expect(page.locator('.cornell-summary-content')).toContainText('间隔与提取是长期记忆的关键。')
  // AI 内容不计入学习统计：顶栏单独显示 AI 字数
  await expect(page.getByText(/AI \d+ 字/)).toBeVisible({ timeout: 5000 })
  await shot('22-mindmap-accepted')
})

test('editing AI content marks it as reviewed', async () => {
  const summaryAi = page.locator('.cornell-summary-content p[data-origin="ai"]')
  await expect(summaryAi).toHaveCount(1)
  await summaryAi.click()
  await page.keyboard.press('End')
  await page.keyboard.type('（我认同）')
  await expect(page.locator('.cornell-summary-content p[data-origin="ai-reviewed"]')).toHaveCount(1)
})

test('mind map expands into Cornell rows', async () => {
  await page.locator('.embed-block').hover()
  await page.getByRole('button', { name: '展开为康奈尔行' }).click()
  await expect(page.locator('.cornell-row')).toHaveCount(4)
  await expect(page.locator('.cornell-row').nth(2).locator('.cornell-cue')).toHaveText('间隔重复')
  await expect(page.locator('.cornell-row').nth(3).locator('.cornell-body')).toContainText('主动回忆')
})

test('blocks record origin; derived text includes the mind map', async () => {
  await page.waitForTimeout(1200)
  const blocks = await page.evaluate((id) => window.jiwei.notes.blocks(id), noteId)
  expect(blocks.find((b) => b.kind === 'embed')?.origin).toBe('ai')
  expect(blocks.some((b) => b.origin === 'user' && b.text === '我自己写的一句话。')).toBe(true)
  // 由 AI 导图展开的行，子块继承 AI 来源
  expect(blocks.find((b) => b.section === 'cue' && b.text === '间隔重复')?.origin).toBe('ai')
  const hits = await page.evaluate(() => window.jiwei.notes.list({ search: '遗忘前复习' }))
  expect(hits.map((n) => n.title)).toContain('学习科学')
})

test('navigation history: back and forward', async () => {
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('第二篇')
  await page.waitForTimeout(700)
  await page.keyboard.press('ControlOrMeta+[')
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('学习科学')
  await page.keyboard.press('ControlOrMeta+]')
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('第二篇')
})

test('settings: knowledge bases and profile', async () => {
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('button', { name: '数据' }).click()
  await expect(page.getByText('知识库', { exact: true })).toBeVisible()
  await expect(page.getByText('当前', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '通用' }).click()
  await expect(page.getByText('你的名字')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('mind map survives restart', async () => {
  await app.close()
  await launch()
  await page.evaluate((id) => {
    // 通过深层链接同款入口打开笔记
    return id
  }, noteId)
  await page.getByText('学习科学', { exact: true }).first().click()
  await expect(page.locator('.embed-block[data-kind="mindmap"] svg.mindmap-svg')).toBeVisible()
  await expect(page.locator('.cornell-row')).toHaveCount(4)
})
