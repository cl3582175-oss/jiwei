import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { makePdf } from './fixtures/makePdf'
import { navTo } from './fixtures/nav'

// 批注（v0.5.3）：文字资料与 PDF 的高亮 / 评论 / 存疑、批注卡片与列表、导出带批注的 PDF、
// 笔记段落批注、进入检索与复盘素材包。
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
const shots = process.env.SHOTS_DIR
const exportDir = mkdtempSync(join(tmpdir(), 'jiwei-anno-export-'))
const dir = mkdtempSync(join(tmpdir(), 'jiwei-anno-src-'))
const ids: Record<string, string> = {}

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-anno-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '', JIWEI_EXPORT_DIR: exportDir }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

async function openSource(title: string): Promise<void> {
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /资料库/)
  await page.getByText(title, { exact: true }).dblclick()
}

/** 选中文字（文字资料的片段或 PDF 文字层），像松开鼠标一样触发浮条 */
async function select(text: string, scope: '.source-text [data-segment]' | '.textLayer span'): Promise<void> {
  await page.evaluate(
    ({ text, scope }) => {
      const el = [...document.querySelectorAll(scope)].find((e) => e.textContent?.includes(text))!
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent!.indexOf(text)
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + text.length)
        getSelection()!.removeAllRanges()
        getSelection()!.addRange(r)
        break
      }
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    },
    { text, scope }
  )
}
const toolbar = () => page.getByRole('toolbar', { name: '选区操作' })
const card = () => page.getByTestId('annotation-card')
const highlightCount = (name: string) => page.evaluate((n) => (CSS.highlights.get(n) as Set<Range> | undefined)?.size ?? 0, name)

test('text source: highlight, comment, question', async () => {
  writeFileSync(
    join(dir, '学习科学.md'),
    '# 学习科学\n\n间隔重复是在快要遗忘时复习，让记忆保持得更久。\n\n提取练习比重读更有效：合上书，自己回忆刚学过的内容。\n\n交错练习把不同类型的题目混在一起做。'
  )
  const res = await page.evaluate((p) => window.jiwei.sources.importPaths([p]), join(dir, '学习科学.md'))
  ids.md = res.imported[0].id
  await expect.poll(() => page.evaluate((id) => window.jiwei.segments.list(id).then((s) => s.length), ids.md)).toBeGreaterThan(2)
  await openSource('学习科学')
  await expect(page.locator('.source-text')).toContainText('间隔重复')

  // 高亮
  await select('快要遗忘时复习', '.source-text [data-segment]')
  await toolbar().getByRole('button', { name: '高亮' }).click()
  await expect.poll(() => highlightCount('jw-yellow')).toBe(1)

  // 批注：写评论
  await select('合上书，自己回忆', '.source-text [data-segment]')
  await toolbar().getByRole('button', { name: '批注' }).click()
  await expect(card()).toBeVisible()
  await card().getByRole('textbox').fill('考试前用这个方法，比反复看笔记好。')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(card()).toHaveCount(0)

  // 存疑
  await select('交错练习', '.source-text [data-segment]')
  await toolbar().getByRole('button', { name: '存疑' }).click()
  await card().getByRole('textbox').fill('交错练习为什么有效？')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect.poll(() => highlightCount('jw-question')).toBe(1)

  const list = await page.evaluate((id) => window.jiwei.annotations.list('source', id), ids.md)
  expect(list.map((a) => a.motivation).sort()).toEqual(['commenting', 'highlighting', 'questioning'])
  const c = list.find((a) => a.motivation === 'commenting')!
  expect(c.body).toBe('考试前用这个方法，比反复看笔记好。')
  expect(c.selector.quote).toBe('合上书，自己回忆')
  expect(c.selector.ownerId).toBeTruthy()
  if (shots) await page.screenshot({ path: join(shots, '190-text-annotations.png') })
})

test('click a highlight: card to recolour, delete and undo', async () => {
  // 点在高亮上
  const box = await page.evaluate(() => {
    const r = [...(CSS.highlights.get('jw-question') as Set<Range>)][0].getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await page.mouse.click(box.x, box.y)
  await expect(card()).toBeVisible()
  await expect(card().getByRole('textbox')).toHaveValue('交错练习为什么有效？')
  await card().getByRole('button', { name: '绿色' }).click()
  await expect.poll(() => highlightCount('jw-green')).toBe(1)
  await card().getByRole('button', { name: '删除批注' }).click()
  await expect.poll(() => highlightCount('jw-question')).toBe(0)
  await page.getByRole('button', { name: '撤销' }).click()
  await expect.poll(() => highlightCount('jw-question')).toBe(1)
})

test('annotations panel: filter and jump', async () => {
  await page.getByRole('button', { name: /批注（3）/ }).click()
  const panel = page.getByTestId('annotations-panel')
  await expect(panel.locator('[data-annotation]')).toHaveCount(3)
  await panel.getByRole('tab', { name: '存疑' }).click()
  await expect(panel.locator('[data-annotation]')).toHaveCount(1)
  await expect(panel).toContainText('交错练习为什么有效？')
  await panel.getByRole('tab', { name: '评论' }).click()
  await expect(panel.locator('[data-annotation]')).toHaveCount(2)
  await expect(panel.getByRole('tab', { name: '评论' })).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByRole('tab', { name: '全部' })).toHaveAttribute('aria-selected', 'false')
  if (shots) await page.screenshot({ path: join(shots, '191-annotations-panel.png') })
  await panel.getByRole('button', { name: '关闭' }).click()
})

test('comments are searchable in the knowledge base', async () => {
  const hits = await page.evaluate(() => window.jiwei.knowledge.search('比反复看笔记好', { type: 'all' }, 8))
  const hit = hits.find((h) => h.text.includes('［批注］考试前用这个方法'))
  expect(hit).toBeTruthy()
  expect(hit!.parentId).toBe(ids.md)
  expect(hit!.text).toContain('原文：合上书，自己回忆')
})

test('PDF: highlight with a question, overlay, export with standard annotations', async () => {
  const file = join(dir, 'Learning Science.pdf')
  writeFileSync(file, makePdf([['Learning Science, Chapter 1', 'Spaced repetition beats cramming.', 'Interleaving creates a desirable difficulty.']]))
  const res = await page.evaluate((p) => window.jiwei.sources.importPaths([p]), file)
  ids.pdf = res.imported[0].id
  await openSource('Learning Science')
  await expect(page.getByTestId('pdf-viewer').locator('.textLayer').first()).toContainText('desirable difficulty', { timeout: 20_000 })
  await select('Spaced repetition beats cramming', '.textLayer span')
  await toolbar().getByRole('button', { name: '存疑' }).click()
  await card().getByRole('textbox').fill('多久复习一次合适？')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.locator('.jw-anno-rect[data-question="1"]')).toHaveCount(1)
  await expect(page.locator('.jw-anno-note')).toHaveCount(1)
  const [a] = await page.evaluate((id) => window.jiwei.annotations.list('source', id), ids.pdf)
  expect(a.selector.page).toBe(1)
  expect(a.selector.rects!.length).toBe(1)
  if (shots) await page.screenshot({ path: join(shots, '192-pdf-annotation.png') })

  // 单击高亮打开卡片
  await page.locator('.jw-anno-note').click()
  await expect(card().getByRole('textbox')).toHaveValue('多久复习一次合适？')
  await page.keyboard.press('Escape')

  // 导出：标准 PDF Highlight 批注，带评论
  await page.getByRole('button', { name: /批注（1）/ }).click()
  await page.getByRole('button', { name: '导出带批注的 PDF' }).click()
  await expect(page.getByText('已导出带批注的 PDF')).toBeVisible()
  const out = join(exportDir, 'Learning Science（批注）.pdf')
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(out)), verbosity: 0 })
  const doc = await task.promise
  const annots = await (await doc.getPage(1)).getAnnotations()
  await task.destroy()
  const h = annots.find((x: { subtype: string }) => x.subtype === 'Highlight') as { contentsObj: { str: string }; quadPoints: unknown } | undefined
  expect(h).toBeTruthy()
  expect(h!.contentsObj.str).toBe('［存疑］多久复习一次合适？')
})

test('note paragraph annotation: bubble beside the paragraph, body untouched', async () => {
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('间隔重复')
  await page.keyboard.press('Enter')
  await page.keyboard.type('复习间隔应该逐渐拉长。')
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '间隔重复' }).then((n) => n.length))).toBeGreaterThan(0)
  ids.note = await page.evaluate(() => window.jiwei.notes.list({ search: '间隔重复' }).then((n) => n[0].id))
  const para = page.locator('.cornell-body p', { hasText: '复习间隔应该逐渐拉长' })
  await para.hover()
  await page.getByRole('button', { name: '给这一段添加批注' }).click()
  await card().getByRole('textbox').fill('拉长到多久？可以参考 FSRS 的间隔。')
  await page.keyboard.press('ControlOrMeta+Enter')
  const bubble = page.getByTestId('note-annotations').locator('[data-annotation]')
  await expect(bubble).toHaveCount(1)
  // 气泡与段落同高
  const [pb, bb] = await Promise.all([para.boundingBox(), bubble.boundingBox()])
  expect(Math.abs(pb!.y - bb!.y)).toBeLessThan(12)
  // 正文不变
  await expect(para).toHaveText('复习间隔应该逐渐拉长。')
  const [a] = await page.evaluate((id) => window.jiwei.annotations.list('note', id), ids.note)
  expect(a.selector.quote).toBe('复习间隔应该逐渐拉长。')
  if (shots) await page.screenshot({ path: join(shots, '193-note-annotation.png') })
  // 重新打开后仍在
  await page.reload()
  await page.waitForSelector('nav')
  await page.evaluate((id) => window.jiwei.notes.get(id), ids.note)
  await page.keyboard.press('ControlOrMeta+1')
  await page.getByText('间隔重复', { exact: true }).first().click()
  await expect(page.getByTestId('note-annotations').locator('[data-annotation]')).toHaveCount(1)
})

test('weekly reflection material lists new annotations', async () => {
  const r = await page.evaluate(() => window.jiwei.reflection.start({ kind: 'weekly' }))
  const m = await page.evaluate((id) => window.jiwei.reflection.material(id), r.id)
  expect(m.annotations.highlights).toBe(5)
  expect(m.annotations.items.map((a) => a.body).sort()).toEqual([
    '交错练习为什么有效？',
    '多久复习一次合适？',
    '拉长到多久？可以参考 FSRS 的间隔。',
    '考试前用这个方法，比反复看笔记好。'
  ])
  expect(m.annotations.items.filter((a) => a.question)).toHaveLength(2)
  expect(m.text).toContain('［存疑］《学习科学》“交错练习”：交错练习为什么有效？')
})
