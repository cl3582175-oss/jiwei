import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { makePdf } from './fixtures/makePdf'
import { launchRagApp } from './fixtures/ragApp'

// v0.2 知识库：本地向量模型（多镜像下载、校验）→ 笔记与资料两类来源建索引 → 混合检索（含隐私与范围过滤）
// 不需要 API Key。
test.describe.configure({ mode: 'serial' })
const userData = mkdtempSync(join(tmpdir(), 'jiwei-e2e-kb-'))
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await launchRagApp(userData)
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

test('local embedding model installs (mirrors + sha256) and starts', async () => {
  test.setTimeout(600_000)
  await page.evaluate(() => window.jiwei.embedding.installLocal())
  const s = await page.evaluate(() => window.jiwei.embedding.status())
  expect(s.state).toBe('ready')
})

test('notes and sources are both indexed', async () => {
  test.setTimeout(120_000)
  // 笔记：示例笔记（康奈尔法）
  await page.evaluate(() => window.jiwei.notes.createSample('zh-CN'))
  // 资料：一份 Markdown
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-kb-src-'))
  writeFileSync(
    join(dir, '遗忘曲线.md'),
    '# 艾宾浩斯遗忘曲线\n\n学习后 20 分钟遗忘约 42%，一天后遗忘约 66%。\n\n## 间隔重复\n\n在快要遗忘的时候复习，记忆保持最久。复习间隔应逐渐拉长。'
  )
  const res = await page.evaluate((p) => window.jiwei.sources.importPaths([p]), join(dir, '遗忘曲线.md'))
  // 先等资料解析完成，再等索引覆盖它（否则可能只等到示例笔记的索引）
  const sid = res.imported[0].id
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.segments.list(id).then((s) => s.length), sid), { timeout: 30_000 })
    .toBeGreaterThan(0)
  await expect
    .poll(
      async () => {
        const s = await page.evaluate(() => window.jiwei.embedding.status())
        if (!(s.total > 5 && s.indexed === s.total)) return false
        // 资料的片段已经进入检索
        const hits = await page.evaluate(
          (id) => window.jiwei.knowledge.search('艾宾浩斯遗忘曲线', { type: 'items', notes: [], sources: [id] }, 3),
          sid
        )
        return hits.length > 0
      },
      { timeout: 90_000 }
    )
    .toBe(true)
})

test('hybrid search finds notes and sources by meaning', async () => {
  const hits = await page.evaluate(() => window.jiwei.knowledge.search('为什么学过的东西很快就忘了？', { type: 'all' }, 5))
  expect(hits.length).toBeGreaterThan(0)
  expect(hits[0].parentType).toBe('source')
  expect(hits[0].title).toContain('遗忘曲线')
  // 语义检索：问题里没有“主动回忆”，仍能找到康奈尔笔记中关于复习的内容
  const recall = await page.evaluate(() => window.jiwei.knowledge.search('复习的时候应该怎么检验自己记住了没有', { type: 'all' }, 5))
  expect(recall.some((h) => h.parentType === 'note' && /回忆/.test(h.text))).toBe(true)
  // 每条结果都带时间
  expect(recall.every((h) => typeof h.updatedAt === 'number')).toBe(true)
})

test('scope and privacy filters', async () => {
  const notes = await page.evaluate(() => window.jiwei.notes.list({}))
  const onlyNote = await page.evaluate(
    (id) => window.jiwei.knowledge.search('遗忘', { type: 'items', notes: [id], sources: [] }, 10),
    notes[0].id
  )
  expect(onlyNote.every((h) => h.parentType === 'note')).toBe(true)
  // 设为“不发送给 AI”后，检索不到这篇笔记
  await page.evaluate((id) => window.jiwei.notes.update(id, { aiExcluded: true }), notes[0].id)
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.jiwei.knowledge.search('康奈尔笔记 线索栏 总结栏', { type: 'all' }, 10))).filter(
          (h) => h.parentType === 'note'
        ).length,
      { timeout: 30_000 }
    )
    .toBe(0)
})

test('PDF source text and page range survive cross-page paragraph grouping', async () => {
  // 回归：pdf.js 在 Electron 工作进程中曾因找不到解析器而全部失败
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-kb-pdf-'))
  const file = join(dir, 'Retrieval Practice.pdf')
  writeFileSync(
    file,
    makePdf([
      ['Retrieval practice', 'Testing yourself beats rereading.'],
      ['Spacing', 'Spread reviews over days.']
    ])
  )
  const res = await page.evaluate((p) => window.jiwei.sources.importPaths([p]), file)
  const id = res.imported[0].id
  await expect.poll(() => page.evaluate((id) => window.jiwei.segments.list(id).then((s) => s.length), id), { timeout: 30_000 }).toBe(1)
  const segs = await page.evaluate((id) => window.jiwei.segments.list(id), id)
  for (const text of ['Retrieval practice', 'Testing yourself beats rereading.', 'Spacing', 'Spread reviews over days.'])
    expect(segs[0].text).toContain(text)
  expect(segs[0]).toMatchObject({ kind: 'page', locator: { value: 'page=1', pageEnd: 2 } })
  const jobs = await page.evaluate(() => window.jiwei.jobs.list())
  expect(jobs.filter((j) => j.kind === 'source.segment' && j.status === 'failed')).toHaveLength(0)
})
