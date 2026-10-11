import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'

// v0.9 洞察看板：真实数据（笔记、复习、阅读时长、作品引用）进入漏斗与四段统计。
test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page
const shots = process.env.SHOTS_DIR
const exportDir = mkdtempSync(join(tmpdir(), 'jiwei-insights-export-'))

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-insights-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '', JIWEI_EXPORT_DIR: exportDir }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.evaluate(async () => {
    const j = window.jiwei
    const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
    for (const title of ['遗忘曲线', '提取练习']) {
      const n = await j.notes.create({ title })
      await j.proposals.create({
        noteId: n.id,
        title: 'x',
        ops: [{ op: 'insert_row', afterRowId: null, cue: [p(`${title}是什么`)], body: [p(`${title}的要点：间隔重复与主动回忆`)] }]
      } as never)
    }
    await j.activity.track([
      { kind: 'read', refType: 'source', refId: 'src-a', durationMs: 10 * 60_000 },
      { kind: 'read', refType: 'web', refId: 'https://example.org/a', durationMs: 5 * 60_000 },
      { kind: 'write', refType: 'note', refId: 'n1', durationMs: 8 * 60_000 }
    ])
  })
  await page.reload()
  await page.waitForSelector('nav')
  for (const title of ['遗忘曲线', '提取练习']) {
    await navTo(page, /^笔记/, { again: true })
    await page.locator('[data-note-id]').filter({ hasText: title }).first().click()
    await page.getByRole('button', { name: '全部接受' }).click()
    await page.waitForTimeout(300)
  }
  await expect
    .poll(() => page.evaluate(() => window.jiwei.knowledge.search('间隔重复', { type: 'all' }).then((h) => h.length)), { timeout: 30_000 })
    .toBeGreaterThan(0)
  // 接受内容后卡片异步生成
  await expect
    .poll(() => page.evaluate(() => window.jiwei.review.today().then((c) => c.length)), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(2)
  await page.evaluate(async () => {
    const j = window.jiwei
    const cards = await j.review.today()
    await j.review.rate(cards[0].id, 3)
    await j.review.rate(cards[1].id, 1)
    // 作品引用一篇笔记并导出：计入“运用”
    const w = await j.works.create({ type: 'article', topic: '间隔重复', mode: 'cowrite' })
    const g = await j.works.gather(w.id)
    const ref = g.materials[0].ref
    await j.works.update({
      id: w.id,
      content: { kind: 'article', parts: [{ id: 'p1', title: '为什么', points: [], sources: [ref], body: `间隔重复有效 [${ref}]` }] }
    })
    await j.works.export(w.id, 'md')
  })
})
test.afterAll(async () => {
  await app?.close()
})

test('复盘 → 洞察：漏斗、投入、内化、产出与成本', async () => {
  await navTo(page, /^复盘/)
  await page.getByRole('button', { name: '洞察', exact: true }).click()
  const view = page.getByTestId('insights-view')
  await expect(view).toBeVisible()
  const funnel = page.getByTestId('knowledge-funnel')
  await expect(funnel.locator('[data-stage="read"]')).toContainText('2')
  await expect(funnel.locator('[data-stage="note"]')).toContainText('2')
  await expect(funnel.locator('[data-stage="apply"]')).toContainText('1')
  await expect(page.getByTestId('funnel-leak')).toContainText('流失最多')
  await expect(page.getByTestId('insights-input')).toContainText('23')
  await expect(page.getByTestId('insights-input')).toContainText('阅读 15′')
  await expect(page.getByTestId('insights-internal')).toContainText('50%')
  await expect(page.getByTestId('insights-internal')).toContainText('2 次复习')
  await expect(page.getByTestId('insights-output')).toContainText('新建 1 · 完成 1')
  await expect(page.getByTestId('insights-output')).toContainText('1 篇笔记被用进作品或决策')
  if (shots) await page.screenshot({ path: join(shots, '401-insights.png'), fullPage: true })
  // 切换统计范围
  await page.getByRole('button', { name: '7 天' }).click()
  await expect(funnel.locator('[data-stage="note"]')).toContainText('2')
})
