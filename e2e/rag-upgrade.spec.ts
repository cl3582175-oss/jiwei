import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { scanImage } from './fixtures/makeScanPdf'
import { launchRagApp } from './fixtures/ragApp'
import { navTo } from './fixtures/nav'
import { pptxFixture } from '../src/main/services/parsers/__tests__/fixtures'

let app: ElectronApplication,
  page: Page,
  sourceId = '',
  oldId = '',
  conversationId = '',
  annotationId = ''
const directory = mkdtempSync(join(tmpdir(), 'jiwei-rag-upgrade-'))
const body = '冷却系统的验收条件是合成风压稳定。完整证据用于引用升级回归。'
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  const cache = process.env.JIWEI_TEST_MODEL_CACHE_ROOT
  process.env.JIWEI_TEST_MODEL_CACHE_ROOT = join(directory, 'empty-model-cache')
  try {
    app = await launchRagApp(directory)
  } finally {
    if (cache === undefined) delete process.env.JIWEI_TEST_MODEL_CACHE_ROOT
    else process.env.JIWEI_TEST_MODEL_CACHE_ROOT = cache
  }
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await page.evaluate(async () => {
    await window.jiwei.settings.set({ retrieval: { autoUpgrade: false } })
  })
})
test.afterAll(async () => {
  await app?.close()
})

test('真实工作进程导入现场生成Word，章节持久化并可搜索与阅读', async () => {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  )
  zip.file(
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  )
  zip.file(
    'word/document.xml',
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一章 合成验收</w:t></w:r></w:p><w:p><w:r><w:t>${body}</w:t></w:r></w:p></w:body></w:document>`
  )
  const path = join(directory, 'generated.docx')
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }))
  sourceId = (await page.evaluate((path) => window.jiwei.sources.importPaths([path]), path)).imported[0].id
  await expect.poll(async () => (await page.evaluate((id) => window.jiwei.segments.list(id), sourceId)).length).toBe(1)
  const segments = await page.evaluate((id) => window.jiwei.segments.list(id), sourceId)
  expect(segments[0]).toMatchObject({ text: body, heading: '第一章 合成验收' })
  expect(await page.evaluate((id) => window.jiwei.sources.outline(id), sourceId)).toEqual([
    { title: '第一章 合成验收', page: null, ordinal: 0 }
  ])
  expect(await page.evaluate(() => window.jiwei.retrieval.upgradeStatus())).toMatchObject({ total: 1, done: 1, paused: true })
  expect(await page.evaluate(() => window.jiwei.embedding.status().then((s) => s.state))).not.toBe('ready')
  expect(
    (await page.evaluate((id) => window.jiwei.knowledge.search('合成风压', { type: 'items', sources: [id], notes: [] }, 8), sourceId))[0]
      .ownerId
  ).toBe(segments[0].id)
  await navTo(page, /资料库/)
  await page.getByText('generated', { exact: true }).dblclick()
  await expect(page.locator('.source-text')).toContainText(body)
})

test('旧切分重读后历史引用和批注定位到新片段，并在重开后保持别名', async () => {
  oldId = randomUUID()
  conversationId = randomUUID()
  await app.evaluate(
    ({ app }, { directory, sourceId, oldId, conversationId, body }) => {
      if (app.getPath('userData') !== directory) throw new Error('Isolated test directory mismatch')
      const loader = process.getBuiltinModule('module')!.createRequire(app.getAppPath() + '/package.json')
      const Database = loader('better-sqlite3'),
        db = new Database(directory + '/data/jiwei.db')
      const hash = loader('node:crypto').createHash('sha1').update('paragraph').update('\0').update(body).digest('hex')
      const now = Date.now()
      db.transaction(() => {
        db.prepare('DELETE FROM source_segments WHERE source_id=?').run(sourceId)
        db.prepare('UPDATE sources SET parse_version=0 WHERE id=?').run(sourceId)
        db.prepare(
          'INSERT INTO source_segments(id,source_id,ordinal,kind,locator,text,hash,created_at,updated_at) VALUES(?,?,0,?,?,?,?,?,?)'
        ).run(oldId, sourceId, 'paragraph', '{}', body, hash, now, now)
        db.prepare('INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)').run(conversationId, '升级前引用', now, now)
        db.prepare(
          "INSERT INTO conversations(id,title,kind,anchor,anchor_parent_id,created_at,updated_at) VALUES(?,?,'inline',?,?,?,?)"
        ).run(
          loader('node:crypto').randomUUID(),
          '旧就地问题',
          JSON.stringify({ kind: 'source-text', parentType: 'source', parentId: sourceId, ownerId: oldId, quote: body }),
          sourceId,
          now,
          now
        )
        const citations = [
          {
            n: 1,
            ownerId: oldId,
            parentType: 'source',
            parentId: sourceId,
            title: 'generated',
            locator: null,
            snippet: body,
            learnedAt: null,
            updatedAt: null,
            status: null,
            origin: null
          }
        ]
        db.prepare('INSERT INTO messages(id,conversation_id,role,content,citations,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(
          loader('node:crypto').randomUUID(),
          conversationId,
          'assistant',
          '旧回答引用仍然可用。[1]',
          JSON.stringify(citations),
          now,
          now
        )
      })()
      db.close()
    },
    { directory, sourceId, oldId, conversationId, body }
  )
  annotationId = (
    await page.evaluate(
      ({ sourceId, oldId, body }) =>
        window.jiwei.annotations.create({
          targetType: 'source',
          targetId: sourceId,
          selector: { ownerId: oldId, quote: body },
          motivation: 'commenting',
          body: '合成升级批注'
        }),
      { sourceId, oldId, body }
    )
  ).id
  const job = (await page.evaluate(() => window.jiwei.jobs.list())).find(
    (j) => j.kind === 'source.segment' && j.key === `segment:${sourceId}`
  )!
  await page.evaluate((id) => window.jiwei.jobs.retry(id), job.id)
  await expect.poll(() => page.evaluate((id) => window.jiwei.segments.resolve(id), oldId)).not.toBe(oldId)
  const resolved = await page.evaluate((id) => window.jiwei.segments.resolve(id), oldId)
  expect(resolved).toBeTruthy()
  const annotation = (await page.evaluate((id) => window.jiwei.annotations.list('source', id), sourceId)).find(
    (a) => a.id === annotationId
  )!
  expect(annotation.selector.ownerId).toBe(resolved)
  expect((await page.evaluate((id) => window.jiwei.chat.threads(id), sourceId))[0].anchor?.ownerId).toBe(resolved)
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /AI 对话/)
  await page.getByText('升级前引用', { exact: true }).click()
  await page.getByRole('button', { name: '[1] generated', exact: true }).click()
  await expect(page.locator(`[data-segment="${resolved}"].is-flash`)).toBeVisible()
  await page.getByRole('button', { name: /批注/ }).first().click()
  await page.getByText('合成升级批注', { exact: true }).click()
  await expect(page.locator(`[data-segment="${resolved}"].is-flash`)).toBeVisible()
  await app.close()
  const cache = process.env.JIWEI_TEST_MODEL_CACHE_ROOT
  process.env.JIWEI_TEST_MODEL_CACHE_ROOT = join(directory, 'empty-model-cache')
  try {
    app = await launchRagApp(directory)
  } finally {
    if (cache === undefined) delete process.env.JIWEI_TEST_MODEL_CACHE_ROOT
    else process.env.JIWEI_TEST_MODEL_CACHE_ROOT = cache
  }
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  expect(await page.evaluate((id) => window.jiwei.segments.resolve(id), oldId)).toBe(resolved)
})

test('旧扫描缓存并入只重切，不重识别，旧OCR片段也写别名', async () => {
  const pdf = await PDFDocument.create(),
    image = await pdf.embedJpg(scanImage(['合成扫描页']))
  pdf.addPage([595, 842]).drawImage(image, { x: 0, y: 0, width: 595, height: 842 })
  const path = join(directory, 'cached-ocr.pdf')
  writeFileSync(path, await pdf.save())
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      ai: { ...s.ai, recognition: { mode: 'off', auto: false, figures: false, providerId: null, model: null } }
    })
  })
  const id = (await page.evaluate((path) => window.jiwei.sources.importPaths([path]), path)).imported[0].id
  await expect.poll(() => page.evaluate((id) => window.jiwei.recognition.source(id).then((r) => r.needs.scan), id)).toBe(1)
  const old = randomUUID()
  await app.evaluate(
    ({ app }, { directory, id, old, body }) => {
      if (app.getPath('userData') !== directory) throw new Error('Isolated test directory mismatch')
      const loader = process.getBuiltinModule('module')!.createRequire(app.getAppPath() + '/package.json')
      const db = new (loader('better-sqlite3'))(directory + '/data/jiwei.db')
      const hash = loader('node:crypto').createHash('sha1').update('ocr:scan').update('\0').update(body).digest('hex')
      db.transaction(() => {
        db.prepare("UPDATE source_pages SET status='done',text=?,engine='controlled-cache' WHERE source_id=? AND need='scan'").run(
          '第一章 合成缓存\n' + body,
          id
        )
        db.prepare('UPDATE sources SET parse_version=0 WHERE id=?').run(id)
        db.prepare(
          'INSERT INTO source_segments(id,source_id,ordinal,kind,locator,text,hash,created_at,updated_at) VALUES(?,?,0,?,?,?,?,1,1)'
        ).run(old, id, 'ocr:scan', '{"value":"page=1"}', body, hash)
      })()
      db.close()
    },
    { directory, id, old, body }
  )
  const before = (await page.evaluate(() => window.jiwei.jobs.list())).filter((j) => j.kind === 'source.recognize').length
  const job = (await page.evaluate(() => window.jiwei.jobs.list())).find((j) => j.kind === 'source.segment' && j.key === `segment:${id}`)!
  await page.evaluate((id) => window.jiwei.jobs.retry(id), job.id)
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.segments.list(id).then((s) => s.some((s) => s.heading === '第一章 合成缓存')), id))
    .toBe(true)
  const next = (await page.evaluate((id) => window.jiwei.segments.list(id), id)).find((s) => s.kind === 'ocr:scan')!
  expect(next.text).toBe(body)
  expect(await page.evaluate((old) => window.jiwei.segments.resolve(old), old)).toBe(next.id)
  expect((await page.evaluate(() => window.jiwei.jobs.list())).filter((j) => j.kind === 'source.recognize')).toHaveLength(before)
})

test('重新解析演示文稿不把旧幻灯片当成网页课程材料追加', async () => {
  const path = join(directory, 'generated-slides.pptx')
  writeFileSync(path, await pptxFixture())
  const id = (await page.evaluate((path) => window.jiwei.sources.importPaths([path]), path)).imported[0].id
  await expect.poll(() => page.evaluate((id) => window.jiwei.segments.list(id).then((s) => s.length), id)).toBe(3)
  const job = (await page.evaluate(() => window.jiwei.jobs.list())).find((j) => j.key === `segment:${id}`)!
  await page.evaluate((id) => window.jiwei.jobs.retry(id), job.id)
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.jobs.list().then((j) => j.find((j) => j.id === id)?.status), job.id))
    .toBe('done')
  expect(await page.evaluate((id) => window.jiwei.segments.list(id).then((s) => s.length), id)).toBe(3)
})
