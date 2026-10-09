import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'
import { makeScanPdf, scanImage } from './fixtures/makeScanPdf'

test.describe.configure({ mode: 'serial' })
const userData = mkdtempSync(join(tmpdir(), 'jiwei-capture-content-'))
const exportDir = mkdtempSync(join(tmpdir(), 'jiwei-capture-export-'))
let app: ElectronApplication
let page: Page
let noteId = ''

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '', JIWEI_EXPORT_DIR: exportDir }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      ai: { ...s.ai, recognition: { mode: 'off', auto: false, figures: false, providerId: null, model: null } }
    })
  })
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('捕捉公式持久化')
  await page.keyboard.press('Enter')
  await expect
    .poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '捕捉公式持久化' }).then((n) => n.length)))
    .toBeGreaterThan(0)
  noteId = await page.evaluate(() => window.jiwei.notes.list({ search: '捕捉公式持久化' }).then((n) => n[0].id))
})
test.afterAll(async () => {
  await app?.close()
})

async function exportFile(format: 'md' | 'html' | 'pdf' | 'docx'): Promise<string> {
  return (await page.evaluate(({ noteId, format }) => window.jiwei.notes.export(noteId, format, {}), { noteId, format }))!
}

test('display and inline formulas are editable, persisted, and exported in all formats', async () => {
  await page.keyboard.type('$$x^2$$')
  await expect(page.locator('[data-type="block-math"]')).toHaveAttribute('data-latex', 'x^2')
  await page.getByRole('button', { name: '编辑公式', exact: true }).click()
  await page.getByRole('textbox', { name: 'LaTeX' }).fill('x^3 + \\alpha')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('[data-type="block-math"]')).toHaveAttribute('data-latex', 'x^3 + \\alpha')
  await expect.poll(async () => readFileSync(await exportFile('md'), 'utf8')).toContain('x^3 + \\alpha')
  await page.evaluate(
    (noteId) =>
      window.jiwei.proposals.create({
        noteId,
        title: '行内公式',
        auto: true,
        ops: [
          {
            op: 'insert_row',
            afterRowId: null,
            cue: [],
            body: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: '能量 ' },
                  { type: 'inlineMath', attrs: { latex: 'E=mc^2' } }
                ]
              }
            ]
          }
        ]
      }),
    noteId
  )
  await expect(page.locator('[data-type="inline-math"][data-latex="E=mc^2"]')).toBeVisible()
  await expect.poll(async () => readFileSync(await exportFile('md'), 'utf8')).toContain('x^3 + \\alpha')
  await page.reload()
  await page.getByText('捕捉公式持久化', { exact: true }).first().click()
  await expect(page.locator('[data-type="block-math"]')).toHaveAttribute('data-latex', 'x^3 + \\alpha')
  await expect(page.locator('[data-type="inline-math"][data-latex="E=mc^2"]')).toBeVisible()
  await page.locator('.cornell-summary-content p').click()
  await page.keyboard.type('行内 $z$')
  await expect(page.locator('[data-type="inline-math"][data-latex="z"]')).toBeVisible()
  const md = readFileSync(await exportFile('md'), 'utf8')
  expect(md).toContain('$$\nx^3 + \\alpha\n$$')
  expect(md).toContain('$E=mc^2$')
  const html = readFileSync(await exportFile('html'), 'utf8')
  expect(html).toContain('katex')
  expect(html).toContain('<math')
  expect(html).not.toContain('cdn.')
  expect(
    readFileSync(await exportFile('pdf'))
      .subarray(0, 4)
      .toString()
  ).toBe('%PDF')
  const docx = await JSZip.loadAsync(readFileSync(await exportFile('docx')))
  const xml = await docx.file('word/document.xml')!.async('string')
  expect(xml).toContain('x^3 + \\alpha')
  expect(xml).toContain('E=mc^2')
  expect(xml).toContain('Menlo')
})

async function insertImage(lines: string[]): Promise<{ assetId: string; blockId: string }> {
  const png = scanImage(lines)
  const asset = await page.evaluate(
    (bytes) => window.jiwei.assets.importBytes('capture.jpg', 'image/jpeg', new Uint8Array(bytes)),
    [...png]
  )
  await page.evaluate(
    ({ noteId, url }) =>
      window.jiwei.proposals.create({
        noteId,
        title: '图片',
        auto: true,
        ops: [{ op: 'insert_row', afterRowId: null, cue: [], body: [{ type: 'image', attrs: { src: url } }] }]
      }),
    { noteId, url: asset.url }
  )
  const image = page.locator('[data-image-block]').last()
  await expect(image).toBeVisible()
  const blockId = (await image.getAttribute('data-image-block'))!
  await expect
    .poll(() =>
      app.evaluate(({ app }, blockId) => {
        const { createRequire } = process.getBuiltinModule('module')
        const { join } = process.getBuiltinModule('path')
        const req = createRequire(join(app.getAppPath(), 'package.json'))
        const Database = req('better-sqlite3') as typeof import('better-sqlite3')
        const db = new Database(join(app.getPath('userData'), 'data/jiwei.db'), { readonly: true })
        try {
          return !!db.prepare('SELECT id FROM note_asset_blocks WHERE block_id = ?').get(blockId)
        } finally {
          db.close()
        }
      }, blockId)
    )
    .toBe(true)
  return { assetId: asset.id, blockId }
}

test('live image references preserve history, exclude private/deleted notes and remove stale searchable image hits', async () => {
  const { assetId, blockId } = await insertImage(['索引隔离测试'])
  // 模拟升级前尚无定位派生表的已有笔记，重启后由启动补建恢复。
  await app.evaluate(({ app }, noteId) => {
    const { createRequire } = process.getBuiltinModule('module')
    const { join } = process.getBuiltinModule('path')
    const req = createRequire(join(app.getAppPath(), 'package.json'))
    const Database = req('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(join(app.getPath('userData'), 'data/jiwei.db'))
    try {
      db.prepare('DELETE FROM note_asset_blocks WHERE note_id = ?').run(noteId)
    } finally {
      db.close()
    }
  }, noteId)
  await app.close()
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '', JIWEI_EXPORT_DIR: exportDir }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await page.getByText('捕捉公式持久化', { exact: true }).first().click()
  // 只为确定性索引/隐私集成验证写入已识别缓存；真实 OCR 语义在下方条件测试单独验证。
  await app.evaluate(({ app }, assetId) => {
    const { createRequire } = process.getBuiltinModule('module')
    const { join } = process.getBuiltinModule('path')
    const req = createRequire(join(app.getAppPath(), 'package.json'))
    const Database = req('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(join(app.getPath('userData'), 'data/jiwei.db'))
    try {
      db.prepare('INSERT OR REPLACE INTO asset_texts VALUES (?, ?, ?, ?)').run(
        assetId,
        '图片缓存定位边界证据',
        'integration-fixture',
        Date.now()
      )
    } finally {
      db.close()
    }
  }, assetId)
  const search = () =>
    page.evaluate(
      (noteId) => window.jiwei.knowledge.search('图片缓存定位边界证据', { type: 'items', notes: [noteId], sources: [] }, 10),
      noteId
    )
  expect(await search()).toEqual(expect.arrayContaining([expect.objectContaining({ ownerId: blockId, parentId: noteId })]))
  expect(
    await page.evaluate((noteId) => window.jiwei.knowledge.search('图片', { type: 'items', notes: [noteId], sources: [] }, 10), noteId)
  ).toEqual(expect.arrayContaining([expect.objectContaining({ ownerId: blockId })]))
  // 使用真实检索结果构造离线引用消息，只验证现有引用点击路径，不模拟模型回答验收。
  const hit = (await search()).find((h) => h.ownerId === blockId)!
  await app.evaluate(({ app }, hit) => {
    const { createRequire } = process.getBuiltinModule('module')
    const { join } = process.getBuiltinModule('path')
    const { randomUUID } = process.getBuiltinModule('crypto')
    const req = createRequire(join(app.getAppPath(), 'package.json'))
    const Database = req('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(join(app.getPath('userData'), 'data/jiwei.db'))
    try {
      const id = randomUUID(),
        now = Date.now()
      db.prepare('INSERT INTO conversations(id,title,created_at,updated_at,updated_by) VALUES (?,?,?,?,?)').run(
        id,
        '图片检索定位',
        now,
        now,
        'fixture'
      )
      db.prepare('INSERT INTO messages(id,conversation_id,role,content,citations,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(
        randomUUID(),
        id,
        'assistant',
        '定位证据 [1]',
        JSON.stringify([{ ...hit, n: 1, snippet: hit.text }]),
        now,
        now
      )
    } finally {
      db.close()
    }
  }, hit)
  await page.getByRole('button', { name: /AI 对话/ }).click()
  await page.getByText('图片检索定位', { exact: true }).click()
  await page.getByRole('button', { name: '[1] 捕捉公式持久化', exact: true }).click()
  await expect(page.locator(`[data-image-block="${blockId}"]`)).toBeInViewport()
  await expect(
    page
      .locator('.is-flash')
      .filter({ has: page.locator(`[data-image-block="${blockId}"]`) })
      .or(page.locator(`[data-image-block="${blockId}"].is-flash`))
  ).toBeVisible()
  await page.evaluate((noteId) => window.jiwei.notes.update(noteId, { aiExcluded: true }), noteId)
  expect(await search()).toEqual([])
  await page.evaluate((noteId) => window.jiwei.notes.update(noteId, { aiExcluded: false }), noteId)
  expect((await search()).length).toBeGreaterThan(0)
  await page.evaluate((noteId) => window.jiwei.notes.trash(noteId), noteId)
  expect(await search()).toEqual([])
  await page.evaluate((noteId) => window.jiwei.trash.restore('note', noteId), noteId)
  await page.getByText('捕捉公式持久化', { exact: true }).first().click()
  expect((await search()).length).toBeGreaterThan(0)
  await page.evaluate(
    ({ noteId, blockId }) =>
      window.jiwei.proposals.create({ noteId, title: '删除图片', auto: true, ops: [{ op: 'delete_block', blockId }] }),
    { noteId, blockId }
  )
  await expect(page.locator(`[data-image-block="${blockId}"]`)).toHaveCount(0)
  await expect.poll(async () => (await search()).filter((h) => h.ownerId === blockId)).toEqual([])
  expect(
    await app.evaluate(
      ({ app }, { noteId, assetId }) => {
        const { createRequire } = process.getBuiltinModule('module')
        const { join } = process.getBuiltinModule('path')
        const req = createRequire(join(app.getAppPath(), 'package.json'))
        const Database = req('better-sqlite3') as typeof import('better-sqlite3')
        const db = new Database(join(app.getPath('userData'), 'data/jiwei.db'), { readonly: true })
        try {
          return !!db.prepare('SELECT 1 FROM note_assets WHERE note_id = ? AND asset_id = ?').get(noteId, assetId)
        } finally {
          db.close()
        }
      },
      { noteId, assetId }
    )
  ).toBe(true)
})

test('review regression: block math keeps existing paragraph suffix when closing dollars are typed', async () => {
  await page.evaluate(
    (noteId) =>
      window.jiwei.proposals.create({
        noteId,
        title: '保留后文',
        auto: true,
        ops: [
          {
            op: 'insert_row',
            afterRowId: null,
            cue: [],
            body: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep this existing suffix' }] }]
          }
        ]
      }),
    noteId
  )
  const paragraph = page.locator('.cornell-body p').filter({ hasText: 'Keep this existing suffix' })
  await paragraph.click()
  await page.keyboard.press('ControlOrMeta+ArrowLeft')
  await page.keyboard.type('$$x$$')
  await expect(page.locator('.cornell-body')).toContainText(['Keep this existing suffix'])
  await expect(page.locator('[data-type="block-math"][data-latex="x"]')).toBeVisible()
  await expect.poll(async () => readFileSync(await exportFile('md'), 'utf8')).toContain('Keep this existing suffix')
})

test('review regression: Word cue inline and block formulas have code fonts on their exact runs', async () => {
  await page.evaluate(
    (noteId) =>
      window.jiwei.proposals.create({
        noteId,
        title: '线索公式样式',
        auto: true,
        ops: [
          {
            op: 'insert_row',
            afterRowId: null,
            cue: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: '普通线索文字 ' },
                  { type: 'inlineMath', attrs: { latex: 'a_{cue}=17' } }
                ]
              },
              { type: 'blockMath', attrs: { latex: 'b_{cue}=29' } }
            ],
            body: [{ type: 'paragraph', content: [{ type: 'text', text: 'Word 回归证据' }] }]
          }
        ]
      }),
    noteId
  )
  await expect.poll(async () => readFileSync(await exportFile('md'), 'utf8')).toContain('a_{cue}=17')
  const zip = await JSZip.loadAsync(readFileSync(await exportFile('docx')))
  const xml = await zip.file('word/document.xml')!.async('string')
  const runs = [...xml.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)].map((m) => m[0])
  for (const formula of ['a_{cue}=17', 'b_{cue}=29']) {
    const run = runs.find((r) => r.includes(formula))
    expect(run, `Word run for ${formula}`).toBeDefined()
    expect(run).toContain('w:ascii="Menlo"')
    expect(run).not.toContain('w:ascii="KaiTi"')
  }
  expect(runs.find((r) => r.includes('普通线索文字'))).toContain('w:ascii="KaiTi"')
})

test('review regression: two nested images recognize the clicked formula and keep both originals', async () => {
  test.skip(process.env.JIWEI_OCR !== '1', 'JIWEI_OCR=1 is required for real local OCR')
  test.setTimeout(1_800_000)
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      ai: { ...s.ai, recognition: { mode: 'local', auto: false, figures: false, providerId: null, model: null } }
    })
  })
  await page.evaluate(() => window.jiwei.recognition.install())
  await expect.poll(() => page.evaluate(() => window.jiwei.recognition.status().then(s => s.state)), { timeout: 1_700_000, intervals: [3000] }).toBe('ready')
  const urls: string[] = []
  for (const line of ['E = mc²', 'y = x³']) {
    const asset = await page.evaluate(
      (bytes) => window.jiwei.assets.importBytes('nested.jpg', 'image/jpeg', new Uint8Array(bytes)),
      [...scanImage([line])]
    )
    urls.push(asset.url)
  }
  await page.evaluate(
    ({ noteId, urls }) =>
      window.jiwei.proposals.create({
        noteId,
        title: '嵌套图片',
        auto: true,
        ops: [
          {
            op: 'insert_row',
            afterRowId: null,
            cue: [],
            body: [{ type: 'blockquote', content: urls.map((src) => ({ type: 'image', attrs: { src } })) }]
          }
        ]
      }),
    { noteId, urls }
  )
  const quote = page.locator('.cornell-body blockquote').last()
  const images = quote.locator('[data-image-block]')
  await expect(images).toHaveCount(2)
  const ids = await images.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-image-block')))
  await images.nth(1).hover()
  await images.nth(1).getByRole('button', { name: '识别为公式' }).click()
  await expect(quote.locator('[data-type="block-math"]')).toHaveCount(1, { timeout: 90_000 })
  expect(await quote.locator('[data-type="block-math"]').first().getAttribute('data-latex')).toMatch(/y\s*=.*x/)
  await images.nth(0).hover()
  await images.nth(0).getByRole('button', { name: '识别为公式' }).click()
  await expect(quote.locator('[data-type="block-math"]')).toHaveCount(2, { timeout: 90_000 })
  const order = await quote
    .locator('[data-image-block], [data-type="block-math"]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-image-block') ?? n.getAttribute('data-latex')))
  expect(order[0]).toBe(ids[0])
  expect(order[1]).toMatch(/E\s*=.*m.*c/)
  expect(order[2]).toBe(ids[1])
  expect(order[3]).toMatch(/y\s*=.*x/)
  await expect(images.nth(0).locator('img')).toHaveAttribute('src', urls[0])
  await expect(images.nth(1).locator('img')).toHaveAttribute('src', urls[1])
})

test.describe('real local OCR', () => {
  test.skip(process.env.JIWEI_OCR !== '1', 'JIWEI_OCR=1 is required for real local OCR and model semantic acceptance')
  test('scanned PDF supports selection and highlight with OCR segment anchors', async () => {
    test.setTimeout(1_800_000)
    await page.evaluate(async () => {
      const s = await window.jiwei.settings.get()
      await window.jiwei.settings.set({
        ai: { ...s.ai, recognition: { mode: 'local', auto: true, figures: false, providerId: null, model: null } }
      })
    })
    await page.evaluate(() => window.jiwei.recognition.install())
    await expect
      .poll(() => page.evaluate(() => window.jiwei.recognition.status().then((s) => s.state)), { timeout: 1_700_000, intervals: [3000] })
      .toBe('ready')
    const file = join(exportDir, '扫描选择.pdf')
    writeFileSync(
      file,
      makeScanPdf(scanImage(['扫描层选择验证', '间隔重复让记忆保持更久。']), {
        caption: 'Table 1',
        rows: [
          ['A', 'B'],
          ['1', '2']
        ]
      })
    )
    const res = await page.evaluate((file) => window.jiwei.sources.importPaths([file]), file)
    const id = res.imported[0].id
    await expect.poll(() => page.evaluate((id) => window.jiwei.recognition.scanPages(id), id), { timeout: 240_000 }).not.toEqual([])
    await page.getByRole('button', { name: /资料库/ }).click()
    await page.getByText('扫描选择', { exact: true }).dblclick()
    await expect(page.locator('.ocrTextLayer span').first()).toBeVisible()
    const firstLine = page.locator('.ocrTextLayer span').first()
    await firstLine.scrollIntoViewIfNeeded()
    const box = (await firstLine.boundingBox())!
    const expectedText = (await firstLine.textContent())!.trim()
    await page.mouse.move(box.x + 1, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 16 })
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim())).toContain(expectedText.slice(0, 4))
    await page.screenshot({ path: '.superpowers/sdd/2026-10-09-capture/task-1-evidence/review-round1/scan-mouse-drag.png' })
    await expect(page.getByRole('button', { name: /高亮/ }).first()).toBeVisible()
    await page.getByRole('button', { name: /高亮/ }).first().click()
    await expect(page.locator('.jw-anno-rect').first()).toBeVisible()
    const annotations = await page.evaluate((id) => window.jiwei.annotations.list('source', id), id)
    const segs = await page.evaluate((id) => window.jiwei.segments.list(id), id)
    expect(annotations[0].selector.ownerId).toBe(segs.find((s) => s.kind === 'ocr:scan')?.id)
    expect(annotations[0].selector.quote).toContain(expectedText.slice(0, 4))
  })
  test('note image OCR is searchable at its image block and formula recognition keeps the original', async () => {
    test.setTimeout(300_000)
    await page.getByRole('button', { name: /笔记/ }).first().click()
    await page.getByText('捕捉公式持久化', { exact: true }).first().click()
    const { blockId } = await insertImage(['图片检索独有词：海马体学习规律', 'E = mc²'])
    await expect
      .poll(
        () =>
          page.evaluate((noteId) => window.jiwei.knowledge.search('海马体', { type: 'items', notes: [noteId], sources: [] }, 5), noteId),
        { timeout: 240_000 }
      )
      .toEqual(expect.arrayContaining([expect.objectContaining({ ownerId: blockId })]))
    const image = page.locator(`[data-image-block="${blockId}"]`)
    await image.hover()
    const before = await page.locator('[data-type="block-math"]').count()
    await image.getByRole('button', { name: '识别为公式' }).click()
    await expect(page.locator('[data-type="block-math"]')).toHaveCount(before + 1, { timeout: 120_000 })
    await expect(image).toBeVisible()
    expect(await page.locator('[data-type="block-math"]').last().getAttribute('data-latex')).toMatch(/E\s*=.*m.*c/)
  })
})
