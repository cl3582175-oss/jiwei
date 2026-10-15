import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { NOTES, QUERIES } from './fixtures/retrievalEval'
import { launchRagApp } from './fixtures/ragApp'

// 检索评估（v0.4.3，决定是否引入重排序模型）：14 篇笔记 + 40 个换了说法的问题，
// 统计正确段落在混合检索结果中的排名：Recall@1/3/5/8/30 与 MRR。
// 回答时会把前 8 条交给模型，所以 Recall@8 最关键；Recall@30 明显高于 Recall@8 时，重排序才有用武之地。
// 运行：JIWEI_EVAL=1 npx playwright test e2e/retrieval-eval.spec.ts（需要本地向量模型，首次会下载）
test.skip(!process.env.JIWEI_EVAL, '设置 JIWEI_EVAL=1 运行检索评估')
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await launchRagApp(mkdtempSync(join(tmpdir(), 'jiwei-e2e-eval-')))
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })

test('evaluate hybrid retrieval', async () => {
  test.setTimeout(900_000)
  await page.evaluate(() => window.jiwei.embedding.installLocal())
  for (const n of NOTES) {
    await page.keyboard.press('ControlOrMeta+n')
    await page.getByPlaceholder('笔记标题').fill(n.title)
    await page.keyboard.press('Enter')
    await page.keyboard.type(' ')
    await expect.poll(() => page.evaluate((t) => window.jiwei.notes.list({ search: t }).then((x) => x.length), n.title)).toBeGreaterThan(0)
    const id = await page.evaluate((t) => window.jiwei.notes.list({ search: t }).then((x) => x[0].id), n.title)
    await page.evaluate(({ id, ops }) => window.jiwei.proposals.create({ noteId: id, title: '语料', ops }), {
      id,
      ops: n.rows.map(([cue, body]) => ({ op: 'insert_row' as const, afterRowId: null, cue: [para(cue)], body: [para(body)] }))
    })
    await page.getByRole('button', { name: '全部接受' }).click()
    await expect(page.getByRole('button', { name: '全部接受' })).toHaveCount(0)
  }
  const rows = NOTES.reduce((s, n) => s + n.rows.length, 0)
  await expect
    .poll(
      async () => {
        const s = await page.evaluate(() => window.jiwei.embedding.status())
        return s.state === 'ready' && s.total >= rows && s.indexed === s.total
      },
      { timeout: 600_000, intervals: [2000] }
    )
    .toBe(true)

  const ranks: { q: string; rank: number | null; top: string }[] = []
  for (const { q, gold } of QUERIES) {
    const hits = await page.evaluate((q) => window.jiwei.knowledge.search(q, { type: 'all' }, 30), q)
    const i = hits.findIndex((h) => h.text.includes(gold))
    ranks.push({ q, rank: i < 0 ? null : i + 1, top: hits[0]?.text.slice(0, 30) ?? '' })
  }
  const at = (k: number): number => ranks.filter((r) => r.rank !== null && r.rank <= k).length / ranks.length
  const mrr = ranks.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / ranks.length
  const report = {
    queries: ranks.length,
    rows,
    'Recall@1': at(1),
    'Recall@3': at(3),
    'Recall@5': at(5),
    'Recall@8': at(8),
    'Recall@30': at(30),
    MRR: Math.round(mrr * 1000) / 1000,
    misses: ranks.filter((r) => r.rank === null || r.rank > 3)
  }
  console.log(JSON.stringify(report, null, 2))
  if (process.env.EVAL_OUT) writeFileSync(process.env.EVAL_OUT, JSON.stringify(report, null, 2))
  // 回归保护：正确段落几乎都应进入交给模型的前 8 条
  expect(report['Recall@8']).toBeGreaterThanOrEqual(0.9)
})
