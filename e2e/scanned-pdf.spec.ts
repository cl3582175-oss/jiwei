import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { PDFDocument } from 'pdf-lib'
import { makeMaskPdf } from './fixtures/makeScanPdf'
import { launchScannedPdfApp } from './fixtures/scannedPdfApp'
import { navTo } from './fixtures/nav'
import { attachmentModel, textOf } from './fixtures/attachment-model'

const evidence = process.env.JIWEI_SCAN_EVIDENCE
function save(name: string, value: unknown) {
  if (!evidence) return
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, name + '.json'), JSON.stringify(value, null, 2) + '\n')
}
async function configure(page: Page, mode: 'off' | 'local' | 'cloud', providerId: string | null = null) {
  await page.evaluate(
    async ({ mode, providerId }) => {
      const s = await window.jiwei.settings.get()
      await window.jiwei.settings.set({
        ai: {
          ...s.ai,
          recognition: { mode, providerId, model: providerId ? 'controlled' : null, auto: false, figures: true, localModel: 'fast' }
        },
        retrieval: { ...s.retrieval, autoUpgrade: false }
      })
    },
    { mode, providerId }
  )
}
async function provider(page: Page, baseUrl: string) {
  return page.evaluate(
    async (baseUrl) =>
      (
        await window.jiwei.providers.save({
          kind: 'openai',
          name: 'Controlled OCR transport',
          baseUrl,
          apiKey: 'synthetic-test-key',
          models: ['controlled'],
          modelCaps: { controlled: { vision: true, tools: true, tier: 'strong' } }
        })
      ).id,
    baseUrl
  )
}
async function snapshot(app: ElectronApplication, directory: string, sourceId: string) {
  return app.evaluate(
    ({ app }, { directory, sourceId }) => {
      if (app.getPath('userData') !== directory) throw new Error('Refusing non-isolated database')
      const load = process.getBuiltinModule('module')!.createRequire(app.getAppPath() + '/package.json')
      const db = new (load('better-sqlite3'))(directory + '/data/jiwei.db', { readonly: true })
      try {
        return {
          source: db.prepare('SELECT id,space,ai_excluded,parse_version FROM sources WHERE id=?').get(sourceId),
          pages: db
            .prepare('SELECT page,need,status,text,engine,error FROM source_pages WHERE source_id=? ORDER BY page,need')
            .all(sourceId),
          segments: db.prepare('SELECT id,text,kind,locator FROM source_segments WHERE source_id=? ORDER BY ordinal').all(sourceId),
          annotations: db.prepare("SELECT id,selector FROM annotations WHERE target_type='source' AND target_id=?").all(sourceId),
          jobs: db
            .prepare("SELECT kind,status,error FROM jobs WHERE json_extract(payload,'$.sourceId')=? ORDER BY created_at")
            .all(sourceId)
        }
      } finally {
        db.close()
      }
    },
    { directory, sourceId }
  )
}
async function project(page: Page, name = '扫描件验证') {
  return page.evaluate((name) => window.jiwei.chatProjects.create({ name, memory: 'project', libraryScope: 'none' }), name)
}
async function upload(page: Page, projectId: string, path: string) {
  const [source] = await page.evaluate(({ id, path }) => window.jiwei.chatProjects.addSources(id, { origin: 'upload', paths: [path] }), {
    id: projectId,
    path
  })
  await expect
    .poll(
      async () => {
        const state = (await page.evaluate((id) => window.jiwei.chatProjects.sources(id), projectId)).find(
          (s) => s.itemId === source.itemId
        )?.readiness
        return !!state && state.state !== 'preparing'
      },
      { timeout: 30000 }
    )
    .toBe(true)
  return source.itemId
}
async function runRecognition(page: Page, id: string) {
  await page.evaluate(async (id) => {
    await window.jiwei.recognition.start(id)
    for (const job of await window.jiwei.jobs.list())
      if (job.kind === 'source.recognize' && job.status === 'queued') await window.jiwei.jobs.runNow(job.id)
  }, id)
}

test('mask upload, explicit blockers, existing-source reprocess, OCR retention and restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-mask-reprocess-'))
  const sourcePdf = await PDFDocument.load(makeMaskPdf()),
    pdf = await PDFDocument.create()
  for (let i = 0; i < 2; i++) pdf.addPage((await pdf.copyPages(sourcePdf, [0]))[0])
  const path = join(dir, '黑白扫描.PDF')
  writeFileSync(path, await pdf.save())
  let { app, page } = await launchScannedPdfApp(dir)
  try {
    await configure(page, 'off')
    const p = await project(page)
    await navTo(page, /积微助手/)
    await page.locator(`[data-project-id="${p.id}"] [data-sidebar-row]`).first().click()
    await page.getByTestId('project-home').getByRole('tab', { name: '来源', exact: true }).click()
    const panel = page.getByRole('tabpanel', { name: '来源', exact: true })
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, path)
    await panel.getByRole('button', { name: '添加来源', exact: true }).first().click()
    await page.getByTestId('add-project-sources').getByRole('button', { name: '上传', exact: true }).click()
    await expect(panel).toContainText('文档识别已关闭')
    const [s] = await page.evaluate((id) => window.jiwei.chatProjects.sources(id), p.id)
    await expect.poll(() => page.evaluate((id) => window.jiwei.recognition.source(id).then((r) => r.needs.scan), s.itemId)).toBe(2)
    await app.evaluate(
      ({ app }, { directory, id }) => {
        if (app.getPath('userData') !== directory) throw new Error('Isolation mismatch')
        const load = process.getBuiltinModule('module')!.createRequire(app.getAppPath() + '/package.json')
        const db = new (load('better-sqlite3'))(directory + '/data/jiwei.db')
        db.prepare(
          "UPDATE source_pages SET status='done',text='PREVIOUS_SYNTHETIC_OCR',engine='local:test-fixture' WHERE source_id=? AND page=1"
        ).run(id)
        db.prepare('DELETE FROM source_pages WHERE source_id=? AND page=2').run(id)
        db.prepare('UPDATE sources SET parse_version=2 WHERE id=?').run(id)
        db.prepare(
          "INSERT INTO jobs(id,kind,payload,status,run_after,dedupe_key,created_at,updated_at) VALUES('queued-upgrade','source.segment',?,'queued',?,?,1,1)"
        ).run(JSON.stringify({ sourceId: id, upgrade: true }), Date.now() + 60000, `segment:${id}`)
        const hash = load('node:crypto').createHash('sha1').update('ocr:scan').update('\0').update('PREVIOUS_SYNTHETIC_OCR').digest('hex')
        db.prepare(
          'INSERT INTO source_segments(id,source_id,ordinal,kind,locator,text,hash,created_at,updated_at) VALUES(?,?,0,?,?,?,?,1,1)'
        ).run('old-ocr-segment', id, 'ocr:scan', '{"value":"page=1"}', 'PREVIOUS_SYNTHETIC_OCR', hash)
        db.prepare(
          "INSERT INTO annotations(id,target_type,target_id,selector,motivation,created_at,updated_at) VALUES(?,'source',?,?,'highlighting',1,1)"
        ).run('old-ocr-annotation', id, '{"ownerId":"old-ocr-segment","quote":"PREVIOUS_SYNTHETIC_OCR"}')
        db.close()
      },
      { directory: dir, id: s.itemId }
    )
    await panel.locator(`[data-project-source-id="${s.itemId}"]`).getByRole('button', { name: '来源菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '重新处理', exact: true }).click()
    await expect.poll(async () => (await snapshot(app, dir, s.itemId)).source.parse_version).toBe(3)
    const state = await snapshot(app, dir, s.itemId)
    expect(state.pages).toHaveLength(2)
    expect(state.pages[0]).toMatchObject({ page: 1, status: 'done', text: 'PREVIOUS_SYNTHETIC_OCR' })
    expect(state.pages[1]).toMatchObject({ page: 2, status: 'pending' })
    expect(state.source).toMatchObject({ id: s.itemId, space: 'attachment', ai_excluded: 1 })
    expect(state.segments.some((segment: { text: string }) => segment.text === 'PREVIOUS_SYNTHETIC_OCR')).toBe(true)
    expect(state.segments[0].id).toBe('old-ocr-segment')
    expect(JSON.parse(state.annotations[0].selector).ownerId).toBe('old-ocr-segment')
    const b = await project(page, '另一个项目')
    await expect(page.evaluate(({ p, s }) => window.jiwei.chatProjects.reprocessSource(p, s), { p: b.id, s: s.itemId })).rejects.toThrow()
    if (evidence) await page.screenshot({ path: join(evidence, 'reprocess-project.png'), fullPage: true })
    await app.close()
    ;({ app, page } = await launchScannedPdfApp(dir))
    expect((await snapshot(app, dir, s.itemId)).pages).toEqual(state.pages)
    expect((await snapshot(app, dir, s.itemId)).annotations).toEqual(state.annotations)
    save('reprocess', { directory: dir, ...state })
  } finally {
    await app.close()
  }
})

test('private project cloud OCR uses real transport and keeps text and citations inside the project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-mask-cloud-')),
    path = join(dir, 'monochrome.pdf')
  writeFileSync(path, makeMaskPdf())
  const model = await attachmentModel()
  model.setAnswer('SCOPED_OCR_EVIDENCE is present on this page.')
  const { app, page } = await launchScannedPdfApp(dir)
  try {
    const id = await provider(page, model.url)
    await configure(page, 'cloud', id)
    const p = await project(page),
      sourceId = await upload(page, p.id, path)
    expect((await page.evaluate((id) => window.jiwei.recognition.source(id), sourceId)).engine).toBe('ready')
    await runRecognition(page, sourceId)
    await expect
      .poll(() => page.evaluate((id) => window.jiwei.recognition.source(id).then((r) => r.done), sourceId), { timeout: 30000 })
      .toBe(1)
    const state = await snapshot(app, dir, sourceId)
    expect(state.source).toMatchObject({ space: 'attachment', ai_excluded: 1 })
    expect(state.segments[0]).toMatchObject({ kind: 'ocr:scan', text: expect.stringContaining('SCOPED_OCR_EVIDENCE') })
    expect(JSON.parse(state.segments[0].locator).value).toBe('page=1')
    expect(model.requests.some((r) => JSON.stringify(r.messages).includes('image'))).toBe(true)
    expect(
      await page.evaluate(
        async (id) => (await window.jiwei.segments.search('SCOPED_OCR_EVIDENCE')).some((s) => s.sourceId === id),
        sourceId
      )
    ).toBe(false)
    const send = async (projectId: string | null) => {
      const turn = await page.evaluate(
        ({ providerId, projectId }) =>
          window.jiwei.chat.send({
            conversationId: null,
            providerId,
            model: 'controlled',
            text: '解释 SCOPED_OCR_EVIDENCE 并注明页码',
            projectId,
            scope: { type: 'none' },
            web: 'off',
            effort: 'off'
          }),
        { providerId: id, projectId }
      )
      await expect
        .poll(
          () =>
            page.evaluate(
              async (turn) =>
                (await window.jiwei.chat.messages(turn.conversation.id)).find((m) => m.id === turn.assistantMessageId)?.status,
              turn
            ),
          { timeout: 30000 }
        )
        .toBe('done')
      return page.evaluate((id) => window.jiwei.chat.messages(id), turn.conversation.id)
    }
    model.setAnswer('这份资料包含该内容 [1]。')
    model.tool('source_read', { sourceId })
    const messages = await send(p.id)
    expect(messages.at(-1)?.citations?.some((c) => c.parentType === 'source' && c.parentId === sourceId)).toBe(true)
    const own = model.requests
      .at(-1)!
      .messages.filter((m) => m.role === 'tool')
      .map((m) => textOf(m.content))
      .join('\n')
    expect(own).toContain('SCOPED_OCR_EVIDENCE is present')
    const b = await project(page, 'Project B')
    model.tool('source_read', { sourceId })
    await send(b.id)
    expect(
      model.requests
        .at(-1)!
        .messages.filter((m) => m.role === 'tool')
        .map((m) => textOf(m.content))
        .join('\n')
    ).not.toContain('SCOPED_OCR_EVIDENCE is present')
    model.tool('source_read', { sourceId })
    await send(null)
    expect(JSON.stringify(model.requests.at(-1)?.messages)).not.toContain('SCOPED_OCR_EVIDENCE is present')
    save('cloud-transport', { directory: dir, ...state, modelRequests: model.requests.length, projectCitation: messages.at(-1)?.citations })
  } finally {
    await app.close()
    await new Promise<void>((resolve) => model.server.close(() => resolve()))
  }
})

test('revoking project ownership stops SDK retries and discards in-flight OCR output', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-mask-revoke-')),
    path = join(dir, 'revoke.pdf')
  writeFileSync(path, makeMaskPdf())
  let calls = 0,
    release: (() => void) | undefined,
    delayed = false
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (b) => (body += b))
    req.on('end', () => {
      calls++
      if (!delayed) {
        res
          .writeHead(503, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'Controlled retry', type: 'overloaded_error' } }))
        return
      }
      release = () =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: 'test',
            object: 'chat.completion',
            created: 1,
            model: 'controlled',
            choices: [{ index: 0, message: { role: 'assistant', content: 'REVOKED_CONTENT' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          })
        )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { app, page } = await launchScannedPdfApp(dir)
  try {
    const id = await provider(page, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`)
    await configure(page, 'cloud', id)
    const a = await project(page),
      sourceId = await upload(page, a.id, path)
    await runRecognition(page, sourceId)
    await expect.poll(() => calls).toBe(1)
    await page.evaluate(({ p, s }) => window.jiwei.chatProjects.removeSource(p, 'source', s), { p: a.id, s: sourceId })
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.jiwei.jobs.list())).some(
          (j) => j.kind === 'source.recognize' && (j.status === 'running' || j.status === 'queued')
        )
      )
      .toBe(false)
    expect(calls).toBe(1)
    expect((await snapshot(app, dir, sourceId)).pages[0].status).toBe('pending')
    delayed = true
    const b = await project(page, 'In-flight'),
      second = await upload(page, b.id, path)
    await runRecognition(page, second)
    await expect.poll(() => !!release).toBe(true)
    await page.evaluate(({ p, s }) => window.jiwei.chatProjects.removeSource(p, 'source', s), { p: b.id, s: second })
    release!()
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.jiwei.jobs.list())).some(
          (j) => j.kind === 'source.recognize' && (j.status === 'running' || j.status === 'queued')
        )
      )
      .toBe(false)
    expect((await snapshot(app, dir, second)).segments).toEqual([])
    save('revocation', { calls, first: await snapshot(app, dir, sourceId), second: await snapshot(app, dir, second) })
  } finally {
    await app.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

for (const change of ['removed', 'disabled', 'endpoint-changed'] as const) {
  test(`provider ${change} discards an in-flight OCR response`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jiwei-scan-provider-')),
      path = join(dir, 'provider.pdf')
    writeFileSync(path, makeMaskPdf())
    let release: (() => void) | undefined
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        release = () =>
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              id: 'delayed',
              object: 'chat.completion',
              created: 1,
              model: 'gpt-4o',
              choices: [{ index: 0, message: { role: 'assistant', content: 'STALE_PROVIDER_RESULT' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            })
          )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { app, page } = await launchScannedPdfApp(dir)
    try {
      const id = await provider(page, `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`)
      await configure(page, 'cloud', id)
      // 使用有默认看图能力的模型名，覆盖服务商被删除后的名称推断分支。
      await page.evaluate(async (providerId) => {
        const s = await window.jiwei.settings.get()
        await window.jiwei.settings.set({ ai: { ...s.ai, recognition: { ...s.ai.recognition!, model: 'gpt-4o' } } })
        await window.jiwei.providers.save({ id: providerId, kind: 'openai', models: ['gpt-4o'] })
      }, id)
      const p = await project(page),
        sourceId = await upload(page, p.id, path)
      await runRecognition(page, sourceId)
      await expect.poll(() => !!release).toBe(true)
      await page.evaluate(
        async ({ id, change }) => {
          if (change === 'removed') await window.jiwei.providers.remove(id)
          else
            await window.jiwei.providers.save({
              id,
              kind: 'openai',
              ...(change === 'disabled' ? { enabled: false } : { baseUrl: 'http://127.0.0.1:1/v1' })
            })
        },
        { id, change }
      )
      release!()
      await expect.poll(async () => (await page.evaluate((id) => window.jiwei.recognition.source(id), sourceId)).running).toBe(false)
      const state = await snapshot(app, dir, sourceId)
      expect(state.pages[0]).toMatchObject({ status: 'pending', text: null })
      expect(state.segments).toEqual([])
      save(`provider-${change}`, state)
    } finally {
      await app.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}

test('real original has every mask page detected and selected pages produce real local OCR', async () => {
  test.skip(
    !process.env.JIWEI_SCAN_REAL_PDF || !process.env.JIWEI_SCAN_OCR_CACHE,
    'Requires explicit original PDF and isolated copy of installed OCR model'
  )
  test.setTimeout(900000)
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-scan-real-')),
    original = process.env.JIWEI_SCAN_REAL_PDF!
  const { app, page } = await launchScannedPdfApp(dir, process.env.JIWEI_SCAN_OCR_CACHE)
  try {
    await configure(page, 'local')
    const a = await project(page, '真实扫描书'),
      fullId = await upload(page, a.id, original)
    await expect
      .poll(() => page.evaluate((id) => window.jiwei.recognition.source(id).then((r) => r.needs.scan), fullId), { timeout: 60000 })
      .toBe(639)
    const full = await snapshot(app, dir, fullId)
    expect(full.pages.filter((p: { page: number }) => p.page >= 5)).toHaveLength(636)
    expect(full.pages.every((p: { status: string; error: string | null }) => p.status === 'pending' && p.error === null)).toBe(true)
    expect(full.segments).toHaveLength(2)
    expect(full.segments.every((s: { locator: string }) => JSON.parse(s.locator).value === 'page=4')).toBe(true)
    const source = await PDFDocument.load(readFileSync(original)),
      selected = await PDFDocument.create(),
      originalPages = [5, 10, 320, 640]
    for (const index of originalPages) selected.addPage((await selected.copyPages(source, [index - 1]))[0])
    const path = join(dir, '资治通鉴-真实选页.pdf')
    writeFileSync(path, await selected.save())
    const sampleId = await upload(page, a.id, path)
    await runRecognition(page, sampleId)
    await expect
      .poll(() => page.evaluate((id) => window.jiwei.recognition.source(id), sampleId), { timeout: 800000, intervals: [1000, 3000, 5000] })
      .toMatchObject({ done: 4, failed: 0, running: false })
    const result = await snapshot(app, dir, sampleId)
    expect(result.pages.every((p: { text: string; status: string }) => p.status === 'done' && p.text?.trim().length > 30)).toBe(true)
    expect(result.pages[0].text).toMatch(/[资資]治通[鉴鑑]/)
    const found = await page.evaluate((id) => window.jiwei.segments.search('通', id), sampleId)
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((s) => s.sourceId === sampleId && typeof s.locator.value === 'string')).toBe(true)
    for (let index = 0; index < 4; index++)
      expect(result.segments.some((s: { locator: string }) => JSON.parse(s.locator).value === `page=${index + 1}`)).toBe(true)
    save('real-local-ocr', { directory: dir, original, originalPages, fullDetection: full, sample: result })
  } finally {
    await app.close()
  }
})
