import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { scanImage } from './fixtures/makeScanPdf'
import { launchRagApp } from './fixtures/ragApp'
import { attachmentModel, textOf } from './fixtures/attachment-model'
import { askInApp } from './fixtures/ragChat'
import { navTo } from './fixtures/nav'
import { readyZh, readyEn } from '../src/renderer/src/features/library/readinessMessages'
let app: ElectronApplication,
  page: Page,
  providerId = '',
  scanId = '',
  unsupportedId = '',
  readyId = '',
  conversationId = '',
  messageId = ''
let model: Awaited<ReturnType<typeof attachmentModel>>
const directory = mkdtempSync(join(tmpdir(), 'jiwei-rag-readiness-'))
const shots = process.env.JIWEI_RAG_SHOTS_DIR ? resolve(process.env.JIWEI_RAG_SHOTS_DIR) : ''
const question = '这份扫描资料说了什么，请据实说明。'
async function launch() {
  const old = process.env.JIWEI_TEST_MODEL_CACHE_ROOT
  process.env.JIWEI_TEST_MODEL_CACHE_ROOT = join(directory, 'empty-cache')
  try {
    app = await launchRagApp(directory)
  } finally {
    if (old === undefined) delete process.env.JIWEI_TEST_MODEL_CACHE_ROOT
    else process.env.JIWEI_TEST_MODEL_CACHE_ROOT = old
  }
  page = await app.firstWindow()
  await page.waitForSelector('nav')
}
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  if (shots) {
    const rel = relative(resolve('.'), shots)
    if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('Screenshots must be outside the repository')
    mkdirSync(shots, { recursive: true })
  }
  model = await attachmentModel({ embeddingDimensions: 768 })
  await launch()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000))
  providerId = await page.evaluate(async (baseUrl) => {
    const p = await window.jiwei.providers.save({
      kind: 'openai',
      name: 'Controlled readiness',
      baseUrl,
      apiKey: 'controlled-test-key',
      models: ['readiness-controlled'],
      modelCaps: { 'readiness-controlled': { vision: true, tools: true, tier: 'strong' } }
    })
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      ai: {
        ...s.ai,
        chat: { providerId: p.id, model: 'readiness-controlled' },
        recognition: {
          ...s.ai.recognition,
          mode: 'cloud',
          providerId: p.id,
          model: 'readiness-controlled',
          auto: false,
          figures: true,
          localModel: 'fast'
        },
        ui: { density: 'off', dataAccess: true, inline: true, localModels: 'off' }
      },
      retrieval: { autoUpgrade: false, mode: 'off' }
    })
    return p.id
  }, model.url)
  await page.reload()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((resolve) => model?.server.close(() => resolve()))
})
const card = (id: string) => page.locator(`[data-source-id="${id}"]`)
const shot = async (name: string) => {
  if (shots) await page.screenshot({ path: join(shots, name + '.png') })
}
const chat = async () => {
  await page
    .getByTestId('nav-rail')
    .getByRole('button', { name: /^(积微助手|Jiwei Assistant)/ })
    .first()
    .click()
  await page.getByText(question, { exact: true }).first().click()
}

test('scan import shows real readiness and passes persisted status into chat as data', async () => {
  const pdf = await PDFDocument.create(),
    image = await pdf.embedJpg(scanImage(['Synthetic scanned evidence']))
  pdf.addPage([595, 842]).drawImage(image, { x: 0, y: 0, width: 595, height: 842 })
  const path = join(directory, 'Synthetic-scan.pdf')
  writeFileSync(path, await pdf.save())
  scanId = (await page.evaluate((path) => window.jiwei.sources.importPaths([path]), path)).imported[0].id
  await expect.poll(async () => (await page.evaluate((id) => window.jiwei.recognition.source(id), scanId)).total).toBe(1)
  expect(await page.evaluate((id) => window.jiwei.sources.readiness([id]), scanId)).toMatchObject({
    [scanId]: { state: 'unreadable', reason: 'scan-pending', action: 'recognize' }
  })
  await navTo(page, /资料库/)
  await expect(card(scanId)).toContainText(readyZh.readyScanAll)
  await expect(card(scanId).getByRole('button', { name: readyZh.readyActRecognize, exact: true })).toBeVisible()
  model.setAnswer('尚未识别扫描页，目前没有读到正文。')
  const response = await askInApp(page, {
    providerId,
    model: 'readiness-controlled',
    text: question,
    scope: { type: 'items', notes: [], sources: [scanId] }
  })
  conversationId = response.conversationId
  messageId = response.message.id
  expect(response.message.readiness?.[0]).toMatchObject({ sourceId: scanId, readiness: { reason: 'scan-pending' } })
  expect(
    model.requests
      .filter((r) => r.stream)
      .at(-1)!
      .messages.map((m) => textOf(m.content))
      .join('\n')
  ).toContain('资料处理情况（回答时如实说明你没有读到的部分）')
  await chat()
  await expect(page.getByTestId('chat-readiness')).toContainText(readyZh.readyScanAll)
  await expect(page.getByText('本回答没有引用你的知识库，内容来自模型的通用知识。', { exact: true })).toHaveCount(0)
})

test('unsupported format is explicit while ready source adds no chat notice', async () => {
  const xls = join(directory, 'Synthetic-legacy.xls'),
    md = join(directory, 'Synthetic-ready.md')
  writeFileSync(xls, 'Controlled unsupported placeholder')
  writeFileSync(md, '# Ready\n\nSynthetic ready evidence is readable and independently verifiable.')
  const imported = (await page.evaluate((paths) => window.jiwei.sources.importPaths(paths), [xls, md])).imported
  unsupportedId = imported.find((s) => s.originalName?.endsWith('.xls'))!.id
  readyId = imported.find((s) => s.originalName?.endsWith('.md'))!.id
  await expect.poll(async () => (await page.evaluate((id) => window.jiwei.segments.list(id), readyId)).length).toBeGreaterThan(0)
  await navTo(page, /资料库/)
  await expect(card(unsupportedId)).toContainText(readyZh.readyUnsupported)
  model.setAnswer('Ready evidence [1].')
  const response = await askInApp(page, {
    providerId,
    model: 'readiness-controlled',
    text: '请阅读就绪资料。',
    scope: { type: 'items', sources: [readyId], notes: [] }
  })
  expect(response.message.readiness ?? []).toEqual([])
  await navTo(page, /AI 对话/)
  await page.getByText('请阅读就绪资料。', { exact: true }).first().click()
  await expect(page.getByTestId('chat-readiness')).toHaveCount(0)
})

test('upgrade switch persists and all readiness surfaces render in Chinese/English and light/dark', async () => {
  await app.evaluate(
    ({ app }, { directory, id }) => {
      if (app.getPath('userData') !== directory) throw new Error('Isolated test directory mismatch')
      const loader = process.getBuiltinModule('module')!.createRequire(app.getAppPath() + '/package.json'),
        db = new (loader('better-sqlite3'))(directory + '/data/jiwei.db')
      db.prepare('UPDATE sources SET parse_version=0 WHERE id=?').run(id)
      db.close()
    },
    { directory, id: readyId }
  )
  for (const language of ['zh-CN', 'en'] as const)
    for (const theme of ['light', 'dark'] as const) {
      const text = language === 'zh-CN' ? readyZh : readyEn
      await page.evaluate((v) => window.jiwei.settings.set(v), { language, theme })
      await page.reload()
      await page.waitForSelector('nav')
      if (language === 'zh-CN') await navTo(page, /资料库/)
      else {
        const group = page
          .getByTestId('nav-rail')
          .getByRole('button', { name: /^Collect/ })
          .first()
        await page.mouse.move(600, 4)
        await group.hover()
        const ring = page.getByTestId('nav-ring')
        if (!(await ring.isVisible())) await group.click()
        await ring.getByRole('menuitem', { name: /^Library/ }).click()
      }
      await expect(card(scanId)).toContainText(text.readyScanAll)
      await shot(`p5-library-${language}-${theme}`)
      await card(scanId).dblclick()
      await expect(page.getByTestId('source-readiness')).toContainText(text.readyScanAll)
      await shot(`p5-reader-${language}-${theme}`)
      await chat()
      await expect(page.getByTestId('chat-readiness')).toContainText(text.readyScanAll)
      await shot(`p5-chat-${language}-${theme}`)
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')
      await page.getByRole('tab', { name: /^AI 模型$|^AI models$/i }).click()
      await page.getByText(text.readyUpgradeTitle, { exact: true }).scrollIntoViewIfNeeded()
      const toggle = page.getByRole('switch', { name: text.readyUpgradeToggle })
      await expect(toggle).not.toBeChecked()
      await toggle.click()
      await expect.poll(async () => (await page.evaluate(() => window.jiwei.settings.get())).retrieval.autoUpgrade).toBe(true)
      await toggle.click()
      await expect.poll(async () => (await page.evaluate(() => window.jiwei.settings.get())).retrieval.autoUpgrade).toBe(false)
      await expect(page.getByTestId('source-upgrade')).toContainText(language === 'zh-CN' ? '已完成 1/2 份' : '1 of 2 done')
      await shot(`p5-settings-${language}-${theme}`)
      await page.keyboard.press('Escape')
    }
})

test('recognition completes through the real job and ask-again reuses original question; snapshot survives restart', async () => {
  await page.evaluate(() => window.jiwei.settings.set({ language: 'zh-CN', theme: 'light' }))
  await page.reload()
  await page.waitForSelector('nav')
  await chat()
  model.setAnswer('Synthetic recognized document body is now searchable.')
  await page.getByTestId('chat-readiness').getByRole('button', { name: readyZh.readyActRecognize, exact: true }).click()
  await expect.poll(async () => (await page.evaluate((id) => window.jiwei.segments.list(id), scanId)).length).toBeGreaterThan(0)
  await expect(page.getByTestId('chat-readiness')).toContainText(readyZh.readyChatDone)
  await page.getByTestId('chat-readiness').getByRole('button', { name: readyZh.readyChatAskAgain, exact: true }).click()
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.jiwei.chat.messages(id), conversationId)).filter(
          (m) => m.role === 'user' && m.content === question
        ).length
    )
    .toBe(2)
  await expect
    .poll(() =>
      model.requests
        .filter((r) => r.stream)
        .at(-1)!
        .messages.filter((m) => m.role === 'user')
        .map((m) => textOf(m.content))
        .at(-1)
    )
    .toContain('Synthetic recognized document body')
  await expect.poll(async () => (await page.evaluate((id) => window.jiwei.chat.messages(id), conversationId)).at(-1)?.status).toBe('done')
  await app.close()
  await launch()
  const saved = (await page.evaluate((id) => window.jiwei.chat.messages(id), conversationId)).find((m) => m.id === messageId)!
  expect(saved.readiness?.[0]).toMatchObject({ sourceId: scanId, readiness: { reason: 'scan-pending' } })
})

test('cloud dimension failure displays exact actionable bilingual error without writing vectors', async () => {
  await page.evaluate(async (providerId) => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...s.ai, embedding: { mode: 'cloud', providerId, model: 'wrong-dim-controlled' } } })
    await window.jiwei.embedding.reindex()
  }, providerId)
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.embedding.status())).state).toBe('error')
  expect((await page.evaluate(() => window.jiwei.embedding.status())).message).toContain('768')
  expect(
    await app.evaluate(({ app }, directory) => {
      if (app.getPath('userData') !== directory) throw new Error('Isolated test directory mismatch')
      const loader = process.getBuiltinModule('module')!.createRequire(app.getAppPath() + '/package.json'),
        db = new (loader('better-sqlite3'))(directory + '/data/jiwei.db')
      db.loadExtension(loader('sqlite-vec').getLoadablePath())
      const n = (db.prepare('SELECT count(*) n FROM vec_chunks').get() as { n: number }).n
      db.close()
      return n
    }, directory)
  ).toBe(0)
  for (const language of ['zh-CN', 'en'] as const) {
    await page.evaluate((language) => window.jiwei.settings.set({ language }), language)
    await page.reload()
    await page.waitForSelector('nav')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')
    await page.getByRole('tab', { name: /^AI 模型$|^AI models$/i }).click()
    const error = page.getByRole('alert').filter({ hasText: '768' })
    await expect(error).toContainText(
      language === 'zh-CN'
        ? '这个向量模型返回的是 768 维，不支持积微需要的 512 维。'
        : "This embedding model returns 768 dimensions and can't produce the 512 that Jiwei needs."
    )
    await expect(error.locator('..')).not.toContainText(language === 'zh-CN' ? '已就绪' : 'Ready ·')
    await error.scrollIntoViewIfNeeded()
    await shot(`p5-dimension-${language}`)
    await page.keyboard.press('Escape')
  }
})

test('queued automatic upgrades recheck exclusion deletion and attachment space in the real worker path', async () => {
  await page.evaluate(() => window.jiwei.settings.set({ retrieval: { autoUpgrade: true } }))
  for (const mode of ['private', 'deleted', 'attachment']) {
    const path = join(directory, `Synthetic-guard-${mode}.md`)
    writeFileSync(path, `# Guard\n\nSynthetic ${mode} source must retain its original parsing state.`)
    const id = (await page.evaluate((path) => window.jiwei.sources.importPaths([path]), path)).imported[0].id
    await expect.poll(async () => (await page.evaluate((id) => window.jiwei.segments.list(id), id)).length).toBeGreaterThan(0)
    const jobId = 'controlled-upgrade-' + mode
    await app.evaluate(
      ({ app }, { directory, id, jobId, mode }) => {
        if (app.getPath('userData') !== directory) throw new Error('Isolated test directory mismatch')
        const loader = process.getBuiltinModule('module')!.createRequire(app.getAppPath() + '/package.json'),
          db = new (loader('better-sqlite3'))(directory + '/data/jiwei.db'),
          at = Date.now()
        db.transaction(() => {
          db.prepare('UPDATE sources SET parse_version=0,ai_excluded=?,deleted_at=?,space=? WHERE id=?').run(
            mode === 'private' ? 1 : 0,
            mode === 'deleted' ? at : null,
            mode === 'attachment' ? 'attachment' : 'library',
            id
          )
          db.prepare(
            "INSERT INTO jobs(id,kind,payload,dedupe_key,status,run_after,created_at,updated_at) VALUES(?,'source.segment',?,?,'queued',?,?,?)"
          ).run(jobId, JSON.stringify({ sourceId: id, upgrade: true }), 'segment:' + id, at - 1, at, at)
        })()
        db.close()
      },
      { directory, id, jobId, mode }
    )
    await expect.poll(async () => (await page.evaluate(() => window.jiwei.jobs.list())).find((j) => j.id === jobId)?.status).toBe('done')
    const saved = await app.evaluate(
      ({ app }, { directory, id, jobId }) => {
        if (app.getPath('userData') !== directory) throw new Error('Isolated test directory mismatch')
        const loader = process.getBuiltinModule('module')!.createRequire(app.getAppPath() + '/package.json'),
          db = new (loader('better-sqlite3'))(directory + '/data/jiwei.db')
        const row = db.prepare('SELECT parse_version FROM sources WHERE id=?').get(id) as { parse_version: number }
        const job = db.prepare('SELECT result FROM jobs WHERE id=?').get(jobId) as { result: string }
        db.close()
        return { version: row.parse_version, result: JSON.parse(job.result) }
      },
      { directory, id, jobId }
    )
    expect(saved).toEqual({ version: 0, result: { skipped: 'ineligible upgrade' } })
  }
})

test('automatic upgrade reuses table cache without scheduling newly discovered figure recognition', async () => {
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      ai: { ...s.ai, recognition: { ...s.ai.recognition!, auto: false, figures: true } },
      retrieval: { autoUpgrade: true }
    })
  })
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica),
    p = pdf.addPage([600, 800])
  p.drawText('Table 1. Synthetic data', { x: 30, y: 700, size: 12, font })
  p.drawText('Figure 1. Synthetic drawing', { x: 30, y: 650, size: 12, font })
  p.drawText('Readable synthetic document body for the automatic upgrade regression.', { x: 30, y: 600, size: 12, font })
  const path = join(directory, 'automatic-cache.pdf')
  writeFileSync(path, await pdf.save())
  const id = (await page.evaluate((path) => window.jiwei.sources.importPaths([path]), path)).imported[0].id
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.recognition.source(id).then((r) => r.needs), id))
    .toMatchObject({ table: 1, figure: 1 })
  await app.evaluate(
    ({ app }, { directory, id }) => {
      if (app.getPath('userData') !== directory) throw new Error('Isolated test directory mismatch')
      const load = process.getBuiltinModule('module')!.createRequire(app.getAppPath() + '/package.json'),
        db = new (load('better-sqlite3'))(directory + '/data/jiwei.db')
      db.prepare("DELETE FROM source_pages WHERE source_id=? AND need='figure'").run(id)
      db.prepare(
        "UPDATE source_pages SET status='done',text='Cached synthetic table',engine='controlled-cache' WHERE source_id=? AND need='table'"
      ).run(id)
      db.prepare('UPDATE sources SET parse_version=0 WHERE id=?').run(id)
      db.close()
    },
    { directory, id }
  )
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...s.ai, recognition: { ...s.ai.recognition!, auto: true } } })
  })
  const jobId = 'automatic-cached-figure'
  await app.evaluate(
    ({ app }, { directory, id, jobId }) => {
      if (app.getPath('userData') !== directory) throw new Error('Isolated test directory mismatch')
      const load = process.getBuiltinModule('module')!.createRequire(app.getAppPath() + '/package.json'),
        db = new (load('better-sqlite3'))(directory + '/data/jiwei.db'),
        at = Date.now()
      db.prepare(
        "INSERT INTO jobs(id,kind,payload,dedupe_key,status,run_after,created_at,updated_at) VALUES(?,'source.segment',?,?,'queued',?,?,?)"
      ).run(jobId, JSON.stringify({ sourceId: id, upgrade: true }), 'segment:' + id, at - 1, at, at)
      db.close()
    },
    { directory, id, jobId }
  )
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.jobs.list())).find((j) => j.id === jobId)?.status).toBe('done')
  expect((await page.evaluate(() => window.jiwei.jobs.list())).filter((j) => j.key === 'recognize:' + id)).toHaveLength(0)
  expect((await page.evaluate((id) => window.jiwei.segments.list(id), id)).some((s) => s.text.includes('Cached synthetic table'))).toBe(
    true
  )
})
