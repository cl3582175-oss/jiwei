import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedElectron } from './fixtures/isolateElectron'
import { attachmentModel } from './fixtures/attachment-model'
import { navTo } from './fixtures/nav'
import { makePdf } from './fixtures/makePdf'

async function setup(options: { chunkDelayMs?: number } = {}) {
  const model = await attachmentModel(options)
  const app = await isolatedElectron.launch({
    args: ['.', '--use-mock-keychain', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-assistant-fixes-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_MEMORY_DELAY_MS: '3600000' }
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => console.error('Renderer error:', error.message))
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 950))
  const providerId = await page.evaluate(async (baseUrl) => {
    const p = await window.jiwei.providers.save({
      kind: 'openai',
      name: '回归服务商',
      baseUrl,
      apiKey: 'local-test-key',
      models: ['default-a', 'manual-b'],
      modelCaps: { 'default-a': { tools: true, tier: 'strong' }, 'manual-b': { tools: true, tier: 'strong' } }
    })
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      ai: { ...s.ai, chat: { providerId: p.id, model: 'default-a' }, effort: 'off' },
      retrieval: { ...s.retrieval, mode: 'off' }
    })
    return p.id
  }, model.url)
  await page.reload()
  await page.waitForSelector('nav')
  return { app, page, model, providerId }
}

async function finish(page: Page, id: string, count: number) {
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.jiwei.chat.messages(id), id)).filter((m) => m.role === 'assistant' && m.status === 'done')
          .length
    )
    .toBe(count)
}

async function close(app: ElectronApplication, model: Awaited<ReturnType<typeof attachmentModel>>) {
  await app.close()
  model.server.closeAllConnections()
  await new Promise<void>((resolve) => model.server.close(() => resolve()))
}

async function sourceFixture(page: Page) {
  const path = join(mkdtempSync(join(tmpdir(), 'jiwei-range-input-')), 'range.pdf')
  writeFileSync(
    path,
    makePdf(
      Array.from({ length: 5 }, (_, n) =>
        Array.from({ length: 17 }, (_, i) => `PAGE-${n + 1} TARGET-${n + 1} line ${i + 1} Evidence for precise source navigation.`)
      )
    )
  )
  const source = await page.evaluate(async (path) => (await window.jiwei.sources.importPaths([path], null)).imported[0], path)
  await expect.poll(async () => (await page.evaluate((id) => window.jiwei.segments.list(id), source.id)).length).toBeGreaterThan(0)
  return source
}

const fifthQuote = 'PAGE-5 TARGET-5 line 1 Evidence for precise source navigation.'
const firstQuote = 'PAGE-1 TARGET-1 line 1 Evidence for precise source navigation.'
async function expectRange(page: Page, quote: string) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...CSS.highlights.values()]
          .flatMap((highlight) =>
            [...highlight]
              .filter((range) => range.startContainer.isConnected && range.getClientRects().length > 0)
              .map((range) => range.toString())
          )
          .join('\n')
      )
    )
    .toContain(quote)
}

async function rangeNote(
  page: Page,
  sourceId: string,
  title: string,
  links: { label: string; page?: number; pageEnd?: number; quote: string }[]
) {
  await page.evaluate(
    async ({ sourceId, title, links }) => {
      const note = await window.jiwei.notes.create({ title })
      await window.jiwei.proposals.create({
        noteId: note.id,
        title,
        auto: true,
        ops: [
          {
            op: 'insert_row',
            afterRowId: null,
            cue: [],
            body: [
              {
                type: 'paragraph',
                content: links.flatMap(({ label, ...selector }) => [
                  {
                    type: 'text',
                    text: label,
                    marks: [
                      { type: 'link', attrs: { href: `jiwei://source/${sourceId}?target=${encodeURIComponent(JSON.stringify(selector))}` } }
                    ]
                  },
                  { type: 'text', text: ' / ' }
                ])
              }
            ]
          }
        ]
      })
    },
    { sourceId, title, links }
  )
  await navTo(page, /笔记/)
  await page
    .getByRole('button', { name: new RegExp(`^${title}`) })
    .first()
    .click()
}

async function pdfPages(page: Page, pages: string[][]) {
  const path = join(mkdtempSync(join(tmpdir(), 'jiwei-range-edge-')), 'edge.pdf')
  writeFileSync(path, makePdf(pages))
  const source = await page.evaluate(async (path) => (await window.jiwei.sources.importPaths([path], null)).imported[0], path)
  await expect.poll(async () => (await page.evaluate((id) => window.jiwei.segments.list(id), source.id)).length).toBeGreaterThan(0)
  return source
}

async function pauseReaderPreparation(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const channel = 'attachments:ofConversation'
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> })._invokeHandlers
    const original = handlers.get(channel)!
    const gate = { entered: false, release: () => {} }
    const wait = new Promise<void>((done) => {
      gate.release = done
    })
    ;(globalThis as unknown as { readerGate: typeof gate }).readerGate = gate
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (...args) => {
      const value = await original(...args)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, original)
      gate.entered = true
      await wait
      return value
    })
  })
}

async function readerPreparationEntered(app: ElectronApplication) {
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { readerGate: { entered: boolean } }).readerGate.entered)).toBe(true)
}

async function releaseReaderPreparation(app: ElectronApplication) {
  await app.evaluate(() => (globalThis as unknown as { readerGate: { release: () => void } }).readerGate.release())
}

test('PDF duplicate quotes stay on the requested page and hot missing ranges report failure', async () => {
  const { app, page, model } = await setup()
  try {
    const quote = 'REPEATED-EVIDENCE exact repeated text'
    const source = await pdfPages(
      page,
      Array.from({ length: 5 }, (_, i) => [quote, `UNIQUE-PAGE-${i + 1}`])
    )
    await rangeNote(page, source.id, '重复文字定位', [
      { label: '第一页', page: 1, quote },
      { label: '第五页', page: 5, quote },
      { label: '已失效的范围', page: 1, quote: 'NO-SUCH-EVIDENCE' }
    ])
    await page.locator('.cornell-body a', { hasText: '第一页' }).click()
    await expectRange(page, quote)
    await page.locator('.cornell-body a', { hasText: '已失效的范围' }).click()
    await expect(page.getByText('失去定位', { exact: true })).toBeVisible()
    await page.locator('.cornell-body a', { hasText: '第五页' }).click()
    await expect(page.locator('.pdfViewer .page[data-page-number="5"]')).toBeInViewport()
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...(CSS.highlights.get('jw-source-target') ?? [])][0]?.startContainer.parentElement
            ?.closest('.page')
            ?.getAttribute('data-page-number')
        )
      )
      .toBe('5')
    await page.getByRole('button', { name: '放大', exact: true }).click()
    await expectRange(page, quote)
  } finally {
    await close(app, model)
  }
})

test('PDF cross-page targets wait for both text layers', async () => {
  const { app, page, model } = await setup()
  try {
    const first = 'CROSS-PAGE-START from page one',
      second = 'CROSS-PAGE-END on page two'
    const source = await pdfPages(page, [[first], [second]])
    await rangeNote(page, source.id, '跨页文字定位', [
      { label: '第一页', page: 1, quote: first },
      { label: '第二页', page: 2, quote: second },
      { label: '跨页范围', page: 1, pageEnd: 2, quote: `${first}\nFigure: retention curve\n${second}` }
    ])
    await page.locator('.cornell-body a', { hasText: '第一页' }).click()
    await expectRange(page, first)
    await page.locator('.cornell-body a', { hasText: '第二页' }).click()
    await expectRange(page, second)
    // A rebuilt first layer may finish after pageEnd; keep the real nodes hidden until ready.
    await page.locator('.page[data-page-number="1"] .textLayer').evaluate((el) => {
      ;(el as HTMLElement).hidden = true
    })
    await page.locator('.cornell-body a', { hasText: '跨页范围' }).click()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect.poll(() => page.evaluate(() => CSS.highlights.get('jw-source-target')?.size ?? 0)).toBe(0)
    await page.locator('.page[data-page-number="1"] .textLayer').evaluate((el) => {
      ;(el as HTMLElement).hidden = false
    })
    await expectRange(page, first)
    await expectRange(page, second)
  } finally {
    await close(app, model)
  }
})

test('PDF active text range returns after actual page recycling', async () => {
  const { app, page, model } = await setup()
  try {
    const first = 'PERSISTENT-PAGE-ONE range'
    const source = await pdfPages(page, [[first], ...Array.from({ length: 16 }, (_, i) => [`RECYCLE-PAGE-${i + 2}`])])
    await rangeNote(page, source.id, '保留范围高亮', [{ label: '第一页范围', page: 1, quote: first }])
    await page.locator('.cornell-body a').click()
    await expectRange(page, first)
    for (let n = 3; n <= 17; n++) {
      const target = page.locator(`.pdfViewer .page[data-page-number="${n}"]`)
      await target.scrollIntoViewIfNeeded()
      await expect(target.locator('.textLayer span')).not.toHaveCount(0)
    }
    await expect(page.locator('.pdfViewer .page[data-page-number="1"] .textLayer span')).toHaveCount(0)
    await page.locator('.pdfViewer .page[data-page-number="1"]').scrollIntoViewIfNeeded()
    await expectRange(page, first)
  } finally {
    await close(app, model)
  }
})

test('a stale segment owner recovers its saved quote elsewhere in the same source', async () => {
  const { app, page, model } = await setup()
  try {
    const quote = 'ALIAS-RECOVERY-UNIQUE saved selected evidence'
    const path = join(mkdtempSync(join(tmpdir(), 'jiwei-alias-edge-')), 'resegmented.txt')
    writeFileSync(path, [...Array.from({ length: 50 }, (_, i) => `Paragraph ${i} ${'source material '.repeat(40)}`), quote].join('\n\n'))
    const source = await page.evaluate(async (path) => (await window.jiwei.sources.importPaths([path], null)).imported[0], path)
    await expect.poll(async () => (await page.evaluate((id) => window.jiwei.segments.list(id), source.id)).length).toBeGreaterThan(1)
    await page.evaluate(
      async ({ sourceId, quote }) => {
        const segments = await window.jiwei.segments.list(sourceId)
        const note = await window.jiwei.notes.create({ title: '重新分段的关联' })
        await window.jiwei.connections.relate(note.id, 'source', sourceId, 'related', false, { ownerId: segments[0].id, quote })
      },
      { sourceId: source.id, quote }
    )
    await navTo(page, /笔记/)
    await page
      .getByRole('button', { name: /^重新分段的关联/ })
      .first()
      .click()
    await page.getByRole('button', { name: 'resegmented', exact: true }).click()
    await expectRange(page, quote)
  } finally {
    await close(app, model)
  }
})

test('model choice survives project first send, navigation and restored history without changing defaults', async () => {
  const { app, page, model } = await setup()
  try {
    const project = await page.evaluate(() => window.jiwei.chatProjects.create({ name: '模型选择项目', libraryScope: 'none' }))
    await navTo(page, /积微助手/)
    await page.locator(`[data-project-id="${project.id}"] [data-sidebar-row]`).first().click()
    const picker = page.getByRole('button', { name: '模型', exact: true })
    const composer = page.getByTestId('project-home').locator('[data-slot="input-group"]')
    await expect(composer.getByRole('button', { name: '模型', exact: true })).toBeVisible()
    await expect(composer.getByRole('button', { name: '思考强度', exact: true })).toBeVisible()
    await expect(picker).toContainText('default-a')
    await picker.click()
    await page.getByRole('option', { name: 'manual-b', exact: true }).click()
    await page.getByRole('textbox').fill('模型选择第一轮')
    await page.getByRole('textbox').press('Enter')
    await expect(page.locator('[data-message-id]')).toHaveCount(2)
    const conv = (await page.evaluate(() => window.jiwei.chat.conversations()))[0]
    await finish(page, conv.id, 1)
    await expect(picker).toContainText('manual-b')
    await page.getByRole('textbox').fill('模型选择第二轮')
    await page.getByRole('textbox').press('Enter')
    await finish(page, conv.id, 2)
    expect(model.requests.filter((r) => r.stream).map((r) => (r as { model?: string }).model)).toEqual(['manual-b', 'manual-b'])
    expect(
      (await page.evaluate((id) => window.jiwei.chat.messages(id), conv.id)).filter((m) => m.role === 'assistant').map((m) => m.model)
    ).toEqual(['manual-b', 'manual-b'])
    await navTo(page, /今日/)
    await navTo(page, /积微助手/)
    await expect(picker).toContainText('manual-b')
    await page.reload()
    await page.waitForSelector('nav')
    await navTo(page, /积微助手/)
    await page.locator(`[data-project-id="${project.id}"] [data-sidebar-row]`).first().click()
    await page.getByTestId('project-home').locator(`[data-conversation-id="${conv.id}"] [data-sidebar-row]`).click()
    await expect(picker).toContainText('manual-b')
    expect((await page.evaluate(() => window.jiwei.settings.get())).ai.chat.model).toBe('default-a')
  } finally {
    await close(app, model)
  }
})

test('Mermaid fences render after streaming, follow theme, survive reload and retain invalid code feedback', async () => {
  const { app, page, model } = await setup({ chunkDelayMs: 80 })
  try {
    model.setAnswer('图示如下：\n\n```mermaid\ngraph TD\n  A[上传] --> B[读取]\n```\n\n图示结束。')
    await navTo(page, /积微助手/)
    await page.getByRole('textbox').fill('请画流程图')
    await page.getByRole('textbox').press('Enter')
    await expect(page.locator('[data-reply-id][data-streaming]')).toBeVisible()
    await expect(page.locator('[data-reply-id] .text-danger')).toHaveCount(0)
    const conv = (await page.evaluate(() => window.jiwei.chat.conversations()))[0]
    await finish(page, conv.id, 1)
    const diagram = page.locator('[data-reply-id] .diagram-svg svg')
    await expect(diagram).toBeVisible()
    await expect(diagram).toContainText('上传')
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate((theme) => window.jiwei.settings.set({ theme }), theme)
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
      await expect(diagram).toBeVisible()
    }
    await page.reload()
    await page.waitForSelector('nav')
    await navTo(page, /积微助手/)
    await page.locator(`[data-conversation-id="${conv.id}"] [data-sidebar-row]`).first().click()
    await expect(diagram).toBeVisible()
    model.setAnswer('```mermaid\nnot-a-mermaid-diagram\n```')
    await page.getByRole('textbox').fill('再画一张')
    await page.getByRole('textbox').press('Enter')
    await finish(page, conv.id, 2)
    const invalid = page.locator('[data-reply-id]').last()
    await expect(invalid.locator('.text-danger')).toBeVisible()
    await expect(invalid.locator('pre')).toContainText('not-a-mermaid-diagram')
    await expect(invalid.locator('.diagram-svg svg')).toHaveCount(0)
  } finally {
    await close(app, model)
  }
})

test('PDF note links locate the requested page and exact range on cold and warm opening', async () => {
  const { app, page, model } = await setup()
  try {
    const source = await sourceFixture(page)
    const noteId = await page.evaluate(
      async ({ sourceId, firstQuote, fifthQuote }) => {
        const note = await window.jiwei.notes.create({ title: 'PDF 范围链接笔记' })
        const link = (label: string, page: number, quote: string) => ({
          type: 'text',
          text: label,
          marks: [{ type: 'link', attrs: { href: `jiwei://source/${sourceId}?page=${page}&quote=${encodeURIComponent(quote)}` } }]
        })
        await window.jiwei.proposals.create({
          noteId: note.id,
          title: '页范围链接',
          auto: true,
          ops: [
            {
              op: 'insert_row',
              afterRowId: null,
              cue: [],
              body: [
                {
                  type: 'paragraph',
                  content: [link('第五页范围', 5, fifthQuote), { type: 'text', text: ' / ' }, link('第一页范围', 1, firstQuote)]
                }
              ]
            }
          ]
        })
        return note.id
      },
      { sourceId: source.id, firstQuote, fifthQuote }
    )
    await navTo(page, /笔记/)
    expect(await page.evaluate((id) => window.jiwei.notes.get(id), noteId)).toMatchObject({ title: 'PDF 范围链接笔记' })
    await page
      .getByRole('button', { name: /^PDF 范围链接笔记/ })
      .first()
      .click()
    await page.locator('.cornell-body a', { hasText: '第五页范围' }).click()
    await expect(page.locator('.pdfViewer .page[data-page-number="5"]')).toBeInViewport()
    await expectRange(page, fifthQuote)
    await page.locator('.cornell-body a', { hasText: '第一页范围' }).click()
    await expect(page.locator('.pdfViewer .page[data-page-number="1"]')).toBeInViewport()
    await expectRange(page, firstQuote)
    await page.locator('.cornell-body a', { hasText: '第五页范围' }).click()
    await expect(page.locator('.pdfViewer .page[data-page-number="5"]')).toBeInViewport()
    await expectRange(page, fifthQuote)
  } finally {
    await close(app, model)
  }
})

test('PDF assistant citations cold-open the cited page and highlight the source evidence', async () => {
  const { app, page, model, providerId } = await setup()
  try {
    const source = await sourceFixture(page)
    model.setAnswer('第五页的具体证据见 [3]。')
    const turn = await page.evaluate(
      ({ sourceId, providerId }) =>
        window.jiwei.chat.send({
          conversationId: null,
          providerId,
          model: 'default-a',
          effort: 'off',
          text: '第五页有什么证据？',
          scope: { type: 'items', sources: [sourceId], notes: [] },
          web: 'off'
        }),
      { sourceId: source.id, providerId }
    )
    await finish(page, turn.conversation.id, 1)
    const message = (await page.evaluate((id) => window.jiwei.chat.messages(id), turn.conversation.id)).at(-1)!
    expect(message.citations).toEqual(expect.arrayContaining([expect.objectContaining({ locator: 'page=5' })]))
    const citedQuote = 'PAGE-5 TARGET-5 line 2 Evidence for precise source navigation.'
    expect(message.citations[0].snippet).toContain(citedQuote)
    await navTo(page, /积微助手/)
    await page.locator(`[data-conversation-id="${turn.conversation.id}"] [data-sidebar-row]`).first().click()
    await page.locator(`[data-message-id="${message.id}"] .cite-chip`).click()
    await expect(page.locator('.pdfViewer .page[data-page-number="5"]')).toBeInViewport()
    await expectRange(page, citedQuote)
  } finally {
    await close(app, model)
  }
})

test('note associations retain a selected source range across reload and let file-only links acquire a range', async () => {
  const { app, page, model } = await setup()
  try {
    const path = join(mkdtempSync(join(tmpdir(), 'jiwei-association-')), '关联原文.txt')
    writeFileSync(path, '起始背景。\n\n需要精确定位的关联证据在这里。\n\n其余段落。')
    const source = await page.evaluate(async (path) => (await window.jiwei.sources.importPaths([path], null)).imported[0], path)
    await expect.poll(async () => (await page.evaluate((id) => window.jiwei.segments.list(id), source.id)).length).toBeGreaterThan(0)
    const data = await page.evaluate(async (sourceId) => {
      const note = await window.jiwei.notes.create({ title: '关联范围笔记' })
      const segment = (await window.jiwei.segments.list(sourceId)).find((s) => s.text.includes('需要精确定位'))!
      const selector = { ownerId: segment.id, quote: '需要精确定位的关联证据在这里。' }
      await window.jiwei.connections.relate(note.id, 'source', sourceId, undefined, undefined, selector)
      return { noteId: note.id, selector }
    }, source.id)
    await expect
      .poll(async () => (await page.evaluate((id) => window.jiwei.connections.get(id), data.noteId)).linked[0]?.selector)
      .toEqual(data.selector)
    await page.reload()
    await page.waitForSelector('nav')
    await navTo(page, /笔记/)
    await page
      .getByRole('button', { name: /^关联范围笔记/ })
      .first()
      .click()
    const linked = page.getByTestId('connections').locator('[data-linked="关联原文"]')
    await linked.getByRole('button', { name: '关联原文', exact: true }).click()
    await expectRange(page, '需要精确定位的关联证据在这里。')
    await page.evaluate(
      async ({ noteId, sourceId }) => {
        await window.jiwei.connections.unrelate(noteId, 'source', sourceId)
        await window.jiwei.connections.relate(noteId, 'source', sourceId)
      },
      { noteId: data.noteId, sourceId: source.id }
    )
    await expect
      .poll(async () => (await page.evaluate((id) => window.jiwei.connections.get(id), data.noteId)).linked[0]?.selector)
      .toBeUndefined()
    const paragraph = page.locator('.source-text [data-segment]').filter({ hasText: '需要精确定位' }).first()
    await paragraph.evaluate((el) => {
      const text = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.includes('需要精确定位'))!
      const start = text.textContent!.indexOf('需要精确定位')
      const range = document.createRange()
      range.setStart(text, start)
      range.setEnd(text, start + '需要精确定位的关联证据在这里。'.length)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await linked.getByRole('button', { name: '记录定位范围：关联原文' }).click()
    await expect
      .poll(async () => (await page.evaluate((id) => window.jiwei.connections.get(id), data.noteId)).linked[0]?.selector?.quote)
      .toBe('需要精确定位的关联证据在这里。')
  } finally {
    await close(app, model)
  }
})

test('opened private project files reach only their reader conversation and revoke on context close or project removal', async () => {
  const { app, page, model, providerId } = await setup()
  const marker = 'READER-PRIVATE-FILE-e812'
  const hiddenMarker = 'UNOPENED-PROJECT-FILE-7fa9'
  try {
    const folder = mkdtempSync(join(tmpdir(), 'jiwei-reader-fixture-'))
    const path = join(folder, '当前项目文件.txt'),
      hidden = join(folder, '未打开项目文件.txt')
    writeFileSync(path, `${marker} 当前文件约定：验收日期是十月十八日。`)
    writeFileSync(hidden, `${hiddenMarker} 这是未明确打开的项目来源。`)
    const data = await page.evaluate(
      async ({ path, hidden }) => {
        const project = await window.jiwei.chatProjects.create({ name: '私有阅读项目', libraryScope: 'none' })
        const sources = await window.jiwei.chatProjects.addSources(project.id, { origin: 'upload', paths: [path, hidden] })
        return { project, sourceId: sources.find((s) => s.title === '当前项目文件')!.itemId }
      },
      { path, hidden }
    )
    await expect
      .poll(async () =>
        (await page.evaluate((id) => window.jiwei.chatProjects.sources(id), data.project.id)).every((s) => s.readiness?.state === 'ready')
      )
      .toBe(true)
    await navTo(page, /积微助手/)
    await page.locator(`[data-project-id="${data.project.id}"] [data-sidebar-row]`).first().click()
    await page.getByRole('tab', { name: '来源', exact: true }).click()
    await page.getByText('当前项目文件', { exact: true }).click()
    await expect(page.locator('.source-text')).toContainText(marker)
    await page.keyboard.press('Meta+n')
    await page.getByPlaceholder('笔记标题').fill('当前项目文件阅读笔记')
    await page.keyboard.press('Enter')
    await page.keyboard.type('这是旁边的笔记内容。')
    await page.keyboard.press('Meta+j')
    const panel = page.getByRole('complementary', { name: '积微助手' })
    await expect(panel).toBeVisible()
    model.setAnswer('已核对当前文件中的约定。')
    model.tool('source_read', { sourceId: data.sourceId, from: 0, count: 1 })
    const start = model.requests.length
    await panel.getByRole('textbox').last().fill('请阅读当前打开文件，并用工具核对原文约定。')
    await panel.getByRole('textbox').last().press('Enter')
    await expect
      .poll(async () => (await page.evaluate(() => window.jiwei.chat.conversations())).some((c) => c.kind === 'workspace'))
      .toBe(true)
    const conversation = (await page.evaluate(() => window.jiwei.chat.conversations())).find((c) => c.kind === 'workspace')!
    await finish(page, conversation.id, 1)
    expect(JSON.stringify(model.requests.slice(start))).toContain(marker)
    expect(JSON.stringify(model.requests.slice(start))).not.toContain(hiddenMarker)
    expect(
      model.requests.slice(start).some((r) => r.messages.some((m) => m.role === 'tool' && JSON.stringify(m.content).includes(marker)))
    ).toBe(true)
    expect(conversation.projectId).toBeNull()
    const segmentId = (await page.evaluate((id) => window.jiwei.segments.list(id), data.sourceId))[0].id
    expect(
      await page.evaluate(({ id, conversationId }) => window.jiwei.segments.get(id, conversationId), {
        id: segmentId,
        conversationId: conversation.id
      })
    ).not.toBeNull()
    await panel.getByRole('button', { name: /^不附带：当前项目文件(?: ·|$)/ }).click()
    await expect
      .poll(() =>
        page.evaluate(({ id, conversationId }) => window.jiwei.segments.get(id, conversationId), {
          id: segmentId,
          conversationId: conversation.id
        })
      )
      .toBeNull()
    const offStart = model.requests.length
    await panel.getByRole('textbox').last().fill('现在只讨论笔记，不附带文件。')
    await panel.getByRole('textbox').last().press('Enter')
    await finish(page, conversation.id, 2)
    expect(JSON.stringify(model.requests.slice(offStart))).not.toContain(marker)
    await panel.getByRole('button', { name: /^恢复附带：当前项目文件(?: ·|$)/ }).click()
    await panel.getByRole('textbox').last().fill('再次读取当前打开文件。')
    await panel.getByRole('textbox').last().press('Enter')
    await finish(page, conversation.id, 3)
    expect(
      await page.evaluate(({ id, conversationId }) => window.jiwei.segments.get(id, conversationId), {
        id: segmentId,
        conversationId: conversation.id
      })
    ).not.toBeNull()
    const pendingStart = model.requests.length
    await pauseReaderPreparation(app)
    await panel.getByRole('textbox').last().fill('准备中撤销文件上下文。')
    await panel.getByRole('textbox').last().press('Enter')
    await readerPreparationEntered(app)
    await panel.getByRole('button', { name: /^不附带：当前项目文件(?: ·|$)/ }).click()
    await releaseReaderPreparation(app)
    await expect(panel.getByRole('button', { name: '发送', exact: true })).toHaveAttribute('aria-busy', 'false')
    expect(model.requests.length).toBe(pendingStart)
    expect(
      await page.evaluate(({ id, conversationId }) => window.jiwei.segments.get(id, conversationId), {
        id: segmentId,
        conversationId: conversation.id
      })
    ).toBeNull()
    await panel.getByRole('button', { name: /^恢复附带：当前项目文件(?: ·|$)/ }).click()
    await panel.getByRole('textbox').last().fill('恢复后读取当前文件。')
    await panel.getByRole('textbox').last().press('Enter')
    await finish(page, conversation.id, 4)
    await panel.getByRole('button', { name: '新对话', exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(({ id, conversationId }) => window.jiwei.segments.get(id, conversationId), {
          id: segmentId,
          conversationId: conversation.id
        })
      )
      .toBeNull()
    await page.getByRole('button', { name: '关闭资料', exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(({ id, conversationId }) => window.jiwei.segments.get(id, conversationId), {
          id: segmentId,
          conversationId: conversation.id
        })
      )
      .toBeNull()
    await expect(panel.getByText('已核对当前文件中的约定。', { exact: true })).toHaveCount(0)
    expect(await page.evaluate((id) => window.jiwei.sources.get(id), data.sourceId)).toMatchObject({
      space: 'attachment',
      aiExcluded: true
    })
    await page.evaluate(({ projectId, sourceId }) => window.jiwei.chatProjects.removeSource(projectId, 'source', sourceId), {
      projectId: data.project.id,
      sourceId: data.sourceId
    })
    const before = (await page.evaluate(() => window.jiwei.chat.conversations())).length
    await expect(
      page.evaluate(
        ({ providerId, projectId, sourceId }) =>
          window.jiwei.chat.send({
            conversationId: null,
            kind: 'workspace',
            providerId,
            model: 'default-a',
            effort: 'off',
            text: '读取已移除来源',
            web: 'off',
            context: { targets: [], sourceId },
            readerSource: { projectId, sourceId }
          }),
        { providerId, projectId: data.project.id, sourceId: data.sourceId }
      )
    ).rejects.toThrow()
    expect((await page.evaluate(() => window.jiwei.chat.conversations())).length).toBe(before)
  } finally {
    await close(app, model)
  }
})
