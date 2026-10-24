import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'http'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Editor } from '@tiptap/core'
import * as Y from 'yjs'
import { yDocToProsemirrorJSON } from '@tiptap/y-tiptap'
import { DOC_FIELD } from '../src/shared/types'

let app: ElectronApplication, page: Page, server: Server
let noteId = '',
  rowId = '',
  imageId = '',
  assetId = '',
  providerId = ''
const ocr = '光合作用的产物是葡萄糖和氧气'
const requests: {
  model: string
  messages: { role: string; content?: unknown; tool_calls?: unknown[] }[]
  tools?: { function: { name: string } }[]
}[] = []
const textOf = (content: unknown): string => (typeof content === 'string' ? content : JSON.stringify(content))
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on('end', () => {
      const input = JSON.parse(body) as (typeof requests)[number]
      requests.push(input)
      const after = input.messages.slice(input.messages.findIndex((m) => m.role === 'user') + 1)
      const results = after.filter((m) => m.role === 'tool')
      const vision = input.model === 'fixture-vision'
      const call = !results.length
        ? { name: 'note_read', args: { noteId } }
        : vision && !after.some((m) => JSON.stringify(m.tool_calls ?? []).includes('note_image_view'))
          ? { name: 'note_image_view', args: { noteId, imageId } }
          : !after.some((m) => JSON.stringify(m.tool_calls ?? []).includes('note_set_cues'))
            ? { name: 'note_set_cues', args: { noteId, cues: [{ rowId, question: '光合作用会产生什么？' }] } }
            : null
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`
      if (call) {
        res.write(
          chunk(
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call-${requests.length}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) }
                }
              ]
            },
            null
          )
        )
        res.write(chunk({}, 'tool_calls'))
      } else {
        res.write(chunk({ role: 'assistant', content: '已生成线索问题，请在笔记中确认。' }, null))
        res.write(chunk({}, 'stop'))
      }
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-note-image-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  providerId = await page.evaluate(
    async (baseUrl) => {
      const p = await window.jiwei.providers.save({
        kind: 'ollama',
        name: 'Image fixture',
        baseUrl,
        models: ['fixture-text', 'fixture-vision'],
        modelCaps: { 'fixture-vision': { vision: true }, 'fixture-text': { vision: false } }
      })
      const s = await window.jiwei.settings.get()
      await window.jiwei.settings.set({
        ai: { ...s.ai, recognition: { mode: 'off', auto: false, figures: false, providerId: null, model: null } }
      })
      return p.id
    },
    `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  )
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('图片线索测试')
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '图片线索测试' }).then((ns) => ns.length))).toBe(1)
  const info = await page.evaluate(async () => {
    const bytes = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
      (c) => c.charCodeAt(0)
    )
    const ref = await window.jiwei.assets.importBytes('leaf.png', 'image/png', bytes)
    const editor = (document.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
    editor.commands.insertContent({ type: 'image', attrs: { src: ref.url, alt: '叶片' } })
    const doc = editor.getJSON()
    let imageId = ''
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') imageId = node.attrs.id
    })
    return {
      noteId: (await window.jiwei.notes.list({ search: '图片线索测试' }))[0].id,
      rowId: doc.content![0].attrs!.id as string,
      imageId,
      assetId: ref.id
    }
  })
  ;({ noteId, rowId, imageId, assetId } = info)
  await app.evaluate(
    ({ app }, { assetId, ocr }) => {
      const { createRequire } = process.getBuiltinModule('module'),
        { join } = process.getBuiltinModule('path')
      const Database = createRequire(join(app.getAppPath(), 'package.json'))('better-sqlite3') as typeof import('better-sqlite3')
      const db = new Database(join(app.getPath('userData'), 'data/jiwei.db'))
      try {
        db.prepare('INSERT INTO asset_texts VALUES (?,?,?,?)').run(assetId, ocr, 'controlled-fixture', Date.now())
      } finally {
        db.close()
      }
    },
    { assetId, ocr }
  )
  await expect(page.locator('.cornell-body img')).toBeVisible()
  // The request below calls the main-process API directly. Wait for the real
  // editor autosave so note_read observes the image, rather than an older doc.
  await expect.poll(async () => {
    const bytes = await page.evaluate((id) => window.jiwei.notes.loadDoc(id).then((state) => Array.from(state)), noteId)
    const saved = new Y.Doc()
    try {
      Y.applyUpdate(saved, new Uint8Array(bytes))
      return JSON.stringify(yDocToProsemirrorJSON(saved, DOC_FIELD)).includes(imageId)
    } finally {
      saved.destroy()
    }
  }).toBe(true)
})
test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((r) => server.close(() => r()))
})
async function ask(model: string) {
  const result = await page.evaluate(
    ({ noteId, providerId, model }) =>
      window.jiwei.chat.send({
        conversationId: null,
        providerId,
        model,
        effort: 'off',
        scope: { type: 'items', notes: [noteId], sources: [] },
        text: '给这篇笔记生成线索问题',
        skill: 'cornell-cues',
        incognito: true
      }),
    { noteId, providerId, model }
  )
  await expect
    .poll(() =>
      page.evaluate(({ id, conv }) => window.jiwei.chat.messages(conv).then((ms) => ms.find((m) => m.id === id)?.status), {
        id: result.assistantMessageId,
        conv: result.conversation.id
      })
    )
    .toBe('done')
}
test('image-only row OCR reaches note_read and creates a visible cue proposal', async () => {
  await ask('fixture-text')
  expect(
    requests
      .filter((r) => r.model === 'fixture-text')
      .some((r) => r.messages.some((m) => m.role === 'tool' && textOf(m.content).includes(ocr)))
  ).toBe(true)
  expect(
    requests.filter((r) => r.model === 'fixture-text').every((r) => !r.tools?.some((t) => t.function.name === 'note_image_view'))
  ).toBe(true)
  await expect(page.getByRole('group', { name: /AI 建议/ }).first()).toContainText('光合作用会产生什么？')
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((theme) => window.jiwei.settings.set({ theme }), theme)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await page.screenshot({ path: `.superpowers/sdd/v0.11.1-fixes/shots/p2-image-cue-${theme}.png` })
  }
})
test('vision model receives note_image_view and actual image bytes in its next request', async () => {
  await ask('fixture-vision')
  const vision = requests.filter((r) => r.model === 'fixture-vision')
  expect(vision[0].tools?.some((t) => t.function.name === 'note_image_view')).toBe(true)
  expect(vision.some((r) => JSON.stringify(r.messages).includes('data:image/png;base64,'))).toBe(true)
})

test('large note image is resized before being sent to the vision model', async () => {
  imageId = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 2100
    const ctx = canvas.getContext('2d')!,
      pixels = ctx.createImageData(2100, 2100)
    let seed = 71
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      pixels.data[i] = seed & 255
      pixels.data[i + 1] = (seed >>> 8) & 255
      pixels.data[i + 2] = (seed >>> 16) & 255
      pixels.data[i + 3] = 255
    }
    ctx.putImageData(pixels, 0, 0)
    const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png'))
    if (blob.size <= 4 * 1024 * 1024) throw new Error('Fixture must exceed 4 MB')
    const ref = await window.jiwei.assets.importBytes('large.png', 'image/png', new Uint8Array(await blob.arrayBuffer()))
    const editor = (document.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
    editor.commands.insertContent({ type: 'image', attrs: { src: ref.url } })
    let id = ''
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image' && node.attrs.src === ref.url) id = node.attrs.id
    })
    return id
  })
  await expect
    .poll(async () => {
      const bytes = await page.evaluate((noteId) => window.jiwei.notes.loadDoc(noteId).then((state) => Array.from(state)), noteId)
      const doc = new Y.Doc()
      Y.applyUpdate(doc, new Uint8Array(bytes))
      const json = yDocToProsemirrorJSON(doc, DOC_FIELD)
      doc.destroy()
      return JSON.stringify(json).includes(imageId)
    })
    .toBe(true)
  const before = requests.length
  await ask('fixture-vision')
  const withImage = requests
    .slice(before)
    .flatMap((r) => r.messages)
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find(
      (p: { type?: string; image_url?: { url: string } }) => p.type === 'image_url' && p.image_url?.url.startsWith('data:image/jpeg;')
    ) as { image_url: { url: string } }
  expect(withImage).toBeDefined()
  const size = await app.evaluate(({ nativeImage }, url) => nativeImage.createFromDataURL(url).getSize(), withImage.image_url.url)
  expect(Math.max(size.width, size.height)).toBe(1600)
})
