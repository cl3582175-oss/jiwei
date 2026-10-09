import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanImage } from './fixtures/makeScanPdf'
let app: ElectronApplication, page: Page
const dir = mkdtempSync(join(tmpdir(), 'jiwei-capture-')),
  fixture = join(dir, 'fixture.jpg'),
  exported = join(dir, 'exports')
const jpeg = scanImage(['随时捕捉学习灵感', '知识需要反复练习'], 800, 450)
writeFileSync(fixture, jpeg)
mkdirSync(exported)
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${dir}`],
    env: {
      ...process.env,
      JIWEI_LANG: 'zh-CN',
      JIWEI_SKIP_ONBOARDING: '1',
      JIWEI_CAPTURE_FIXTURE: fixture,
      JIWEI_EXPORT_DIR: exported,
      JIWEI_IMPORT_PROVIDERS_FROM: process.env.JIWEI_IMPORT_PROVIDERS_FROM ?? ''
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  if (process.env.JIWEI_TEST_WINDOW)
    await app.evaluate(({ BrowserWindow }, size) => {
      const [width, height] = size.split('x').map(Number)
      BrowserWindow.getAllWindows()[0].setSize(width, height)
    }, process.env.JIWEI_TEST_WINDOW)
  await page.evaluate(async (ocr) => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      capture: { ...s.capture, sourceInfo: false },
      ai: { ...s.ai, recognition: { mode: ocr ? 'local' : 'off', auto: false, figures: false, providerId: null, model: null } }
    })
  }, process.env.JIWEI_OCR === '1')
})
test.afterAll(async () => {
  await app?.close()
})
async function open(mode: 'text' | 'screenshot'): Promise<Page> {
  const next = app.waitForEvent('window')
  await page.evaluate((mode) => window.jiwei.capture.open(mode), mode)
  const window = await next
  await window.waitForSelector('[data-testid="capture-window"]')
  return window
}
async function inbox(): Promise<void> {
  await page.keyboard.press('ControlOrMeta+0')
  await expect(page.getByTestId('inbox-view')).toBeVisible()
}
test('quick capture text and image paste use real inbox import and primary window', async () => {
  let capture = await open('text')
  await capture.getByRole('textbox', { name: '捕捉内容' }).fill('全局快速记录真实文字')
  await capture.keyboard.press('ControlOrMeta+Enter').catch((e) => {
    if (!capture.isClosed()) throw e
  })
  await expect.poll(() => capture.isClosed()).toBe(true)
  await inbox()
  await expect(page.getByText('全局快速记录真实文字', { exact: true })).toBeVisible()
  capture = await open('text')
  await capture.evaluate((bytes) => {
    const file = new File([new Uint8Array(bytes)], 'pasted.jpg', { type: 'image/jpeg' })
    const data = new DataTransfer()
    data.items.add(file)
    document.querySelector('textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, Array.from(jpeg))
  await expect(capture.getByAltText('捕捉的图片')).toBeVisible()
  await capture.getByRole('textbox', { name: '捕捉内容' }).fill('粘贴图片正文')
  await capture.getByRole('button', { name: '存入收件箱' }).click()
  await expect
    .poll(() => page.evaluate(() => window.jiwei.inbox.list().then((items) => items.some((i) => i.text === '粘贴图片正文' && !!i.assetId))))
    .toBe(true)
})
test('screenshot import saves without OCR and cursor insertion preserves original location and reloads', async () => {
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('截图光标目标')
  await page.keyboard.press('Enter')
  await expect(page.locator('.cornell-doc')).toBeVisible()
  await page.locator('.cornell-body p').first().click()
  await page.keyboard.type('before AFTER')
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft')
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '截图光标目标' }).then((n) => n.length))).toBeGreaterThan(0)
  const noteId = await page.evaluate(() => window.jiwei.notes.list({ search: '截图光标目标' }).then((n) => n[0].id))
  expect(await page.evaluate(() => window.getSelection()?.anchorOffset)).toBe(7)
  let capture = await open('screenshot')
  await expect(capture.getByAltText('捕捉的图片')).toBeVisible()
  await capture.getByRole('textbox', { name: '捕捉内容' }).fill('截图识别可编辑正文')
  await capture.getByRole('button', { name: '插入当前笔记' }).click()
  await expect.poll(() => capture.isClosed()).toBe(true)
  await expect(page.locator('.cornell-doc')).toContainText('截图识别可编辑正文')
  await expect(page.locator('.cornell-doc img')).toBeVisible()
  const path = await page.evaluate((id) => window.jiwei.notes.export(id, 'md', {}), noteId)
  const markdown = readFileSync(path!, 'utf8')
  expect(markdown).toContain('截图识别可编辑正文')
  expect(markdown.indexOf('before')).toBeLessThan(markdown.indexOf('截图识别可编辑正文'))
  expect(markdown.indexOf('AFTER')).toBeGreaterThan(markdown.indexOf('截图识别可编辑正文'))
  await page.reload()
  await page.getByText('截图光标目标', { exact: true }).first().click()
  await expect(page.locator('.cornell-doc')).toContainText('截图识别可编辑正文')
  await page.locator('.cornell-body p').first().click()
  capture = await open('screenshot')
  await expect(capture.getByAltText('捕捉的图片')).toBeVisible()
  await capture.getByRole('textbox', { name: '捕捉内容' }).fill('截图进入收件箱')
  await capture.getByRole('button', { name: '存入收件箱' }).click()
  await inbox()
  await expect(page.getByText('截图进入收件箱', { exact: true })).toBeVisible()
})
test('phone HTTP service validates real bytes, counts received uploads and closes with dialog', async () => {
  await inbox()
  await page.getByRole('button', { name: '从手机上传' }).click()
  await expect(page.getByAltText('手机上传二维码')).toBeVisible()
  const state = (await page.evaluate(() => window.jiwei.phone.status()))!
  const response = await fetch(state.url)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect((await fetch(state.url.replace(/.$/, '!'))).status).toBe(404)
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    fetch(state.url, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'X-Filename': encodeURIComponent('../../outside.jpg'), ...headers },
      body
    })
  expect((await post('invalid')).status).toBe(415)
  expect((await post(Buffer.from([255, 216, 255, 0]))).status).toBe(415)
  expect((await post(new Uint8Array(25 * 1024 * 1024 + 1))).status).toBe(413)
  expect((await post(jpeg, { 'X-Note': encodeURIComponent('手机真实上传备注') })).status).toBe(201)
  await expect(page.getByRole('status')).toContainText('已收到 1 个文件')
  expect(existsSync(join(dir, '..', 'outside.jpg'))).toBe(false)
  const item = await page.evaluate(() => window.jiwei.inbox.list().then((i) => i.find((x) => x.origin.device === 'phone')))
  expect(item?.assetId).toMatch(/^[a-f0-9]{64}$/)
  expect(item?.origin.sessionId).toBe(state.sessionId)
  expect(item?.text).toContain('手机真实上传备注')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.jiwei.phone.status())).toBe(null)
  await expect(fetch(state.url)).rejects.toThrow()
  const ownership = await page.evaluate(async () => {
    const old = await window.jiwei.phone.start()
    const next = await window.jiwei.phone.start()
    await window.jiwei.phone.stop(old.sessionId)
    const active = await window.jiwei.phone.status()
    await window.jiwei.phone.stop(next.sessionId)
    return active?.sessionId === next.sessionId && active.active
  })
  expect(ownership).toBe(true)
  await expect(page.getByTestId('inbox-view')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({
    path:
      (process.env.SHOTS_DIR ? process.env.SHOTS_DIR + '/capture-inbox-' : '.superpowers/sdd/2026-10-09-capture/task-3-evidence/inbox-') +
      (process.env.JIWEI_TEST_WINDOW || 'default') +
      '.png'
  })
})
test('clipboard detects new copy and settings retain scheduler preferences', async () => {
  const s = await page.evaluate(async () => {
    await window.jiwei.settings.set({ capture: { daily: false, time: '03:45', offPeak: true } })
    return window.jiwei.settings.set({ capture: { quickShortcut: '' } })
  })
  expect(s.capture).toMatchObject({ daily: false, time: '03:45', offPeak: true, quickShortcut: '' })
  const copied = `刚复制的学习内容-${Date.now()}`
  await app.evaluate(async ({ clipboard }, text) => {
    await clipboard.writeText(text)
  }, copied)
  await page.waitForTimeout(1200)
  const capture = await open('text')
  await capture.getByRole('button', { name: '粘贴剪贴板内容？' }).click()
  await expect(capture.getByRole('textbox', { name: '捕捉内容' })).toHaveValue(copied)
  await capture.keyboard.press('Escape').catch((e) => {
    if (!capture.isClosed()) throw e
  })
  await expect.poll(() => capture.isClosed()).toBe(true)
})
test('local screenshot OCR recognizes Chinese', async () => {
  test.skip(process.env.JIWEI_OCR !== '1', 'requires local OCR model')
  test.setTimeout(180000)
  const capture = await open('screenshot')
  await expect(capture.getByRole('textbox', { name: '捕捉内容' })).toHaveValue(/学习|知识/, { timeout: 120000 })
  const result = await capture.evaluate(() => window.jiwei.capture.state())
  writeFileSync(
    process.env.SHOTS_DIR
      ? process.env.SHOTS_DIR + '/ocr-result.json'
      : '.superpowers/sdd/2026-10-09-capture/task-3-evidence/ocr-result.json',
    JSON.stringify(result?.recognition, null, 2)
  )
  await capture.keyboard.press('Escape').catch((e) => {
    if (!capture.isClosed()) throw e
  })
})
test('screenshot Ask AI keeps image context with no model; configured provider answers', async () => {
  test.setTimeout(180000)
  const capture = await open('screenshot')
  await expect(capture.getByAltText('捕捉的图片')).toBeVisible()
  await capture.getByRole('textbox', { name: '捕捉内容' }).fill('请解释学习与反复练习的关系')
  await capture.getByRole('button', { name: '就这块问 AI' }).click()
  await expect.poll(() => capture.isClosed(), { timeout: 30000 }).toBe(true)
  if (process.env.JIWEI_IMPORT_PROVIDERS_FROM) {
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const items = await window.jiwei.inbox.list()
            const source = items.find((i) => i.text === '请解释学习与反复练习的关系')?.filedTo?.sourceIds?.[0]
            if (!source) return ''
            const threads = await window.jiwei.chat.threads(source)
            if (!threads.length) return ''
            const messages = await window.jiwei.chat.messages(threads[0].id)
            return messages.find((m) => m.role === 'assistant' && m.status === 'done')?.content ?? ''
          }),
        { timeout: 120000 }
      )
      .toMatch(/学习|练习/)
  } else {
    await expect(page.getByText('请先选择模型', { exact: false }).first()).toBeVisible()
    await expect(page.getByRole('dialog', { name: '就地答复' }).getByAltText('框选提问')).toBeVisible()
  }
})

test('recent clipboard image shows completed OCR, remains editable, inserts at cursor and preserves typed notes', async () => {
  test.skip(process.env.JIWEI_OCR !== '1', 'requires local OCR model')
  test.setTimeout(180000)
  const putImage = async (): Promise<void> => {
    await app.evaluate(async ({ clipboard }, marker) => {
      await clipboard.writeText(marker)
    }, `clipboard-baseline-${Date.now()}`)
    await page.waitForTimeout(1200)
    await app.evaluate(async ({ clipboard, ClipboardItem, nativeImage }, bytes) => {
      const png = nativeImage.createFromBuffer(Buffer.from(bytes)).toPNG()
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png]) })])
    }, Array.from(jpeg))
    await page.waitForTimeout(1200)
  }
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('近期剪贴板图片 OCR')
  await page.keyboard.press('Enter')
  await expect(page.locator('.cornell-doc')).toBeVisible()
  await page.locator('.cornell-body p').first().click()
  await page.keyboard.type('LEFT RIGHT')
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft')
  await expect
    .poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '近期剪贴板图片 OCR' }).then((n) => n.length)))
    .toBeGreaterThan(0)
  const noteId = await page.evaluate(() => window.jiwei.notes.list({ search: '近期剪贴板图片 OCR' }).then((n) => n[0].id))
  await putImage()
  let capture = await open('text')
  await capture.getByRole('button', { name: '粘贴剪贴板内容？' }).click()
  await expect(capture.getByAltText('捕捉的图片')).toBeVisible()
  await expect
    .poll(() => capture.evaluate(() => window.jiwei.capture.state().then((s) => s?.recognitionState)), { timeout: 120000 })
    .toBe('ready')
  const content = capture.getByRole('textbox', { name: '捕捉内容' })
  await expect(content).toHaveValue(/随时捕捉学习灵感/)
  const recognized = await content.inputValue(),
    edited = `${recognized}\n（用户已编辑）`
  await content.fill(edited)
  await capture.getByRole('button', { name: '插入当前笔记' }).click()
  await expect.poll(() => capture.isClosed()).toBe(true)
  await expect(page.locator('.cornell-doc')).toContainText('用户已编辑')
  const path = await page.evaluate((id) => window.jiwei.notes.export(id, 'md', {}), noteId)
  const markdown = readFileSync(path!, 'utf8')
  expect(markdown).toContain(recognized)
  expect(markdown).toContain('用户已编辑')
  expect(markdown.indexOf('LEFT')).toBeLessThan(markdown.indexOf(recognized))
  expect(markdown.indexOf('RIGHT')).toBeGreaterThan(markdown.indexOf(recognized))
  await putImage()
  capture = await open('text')
  await capture.getByRole('textbox', { name: '捕捉内容' }).fill('用户事先输入的笔记')
  await capture.getByRole('button', { name: '粘贴剪贴板内容？' }).click()
  await expect
    .poll(() => capture.evaluate(() => window.jiwei.capture.state().then((s) => s?.recognitionState)), { timeout: 120000 })
    .toBe('ready')
  await expect(capture.getByRole('textbox', { name: '捕捉内容' })).toHaveValue('用户事先输入的笔记')
  await capture.getByRole('button', { name: '存入收件箱' }).click()
  await expect
    .poll(() =>
      page.evaluate(() => window.jiwei.inbox.list().then((items) => items.some((i) => i.text === '用户事先输入的笔记' && !!i.assetId)))
    )
    .toBe(true)
  writeFileSync(
    (process.env.SHOTS_DIR
      ? process.env.SHOTS_DIR + '/recent-image-'
      : '.superpowers/sdd/2026-10-09-capture/task-3-evidence/review-round1/recent-image-') +
      (process.env.JIWEI_TEST_WINDOW || 'default') +
      '.json',
    JSON.stringify({ recognized, edited, markdown, typedTextPreserved: true }, null, 2)
  )
})

test('expired recent clipboard click hides the stale prompt, explains expiry and stores nothing', async () => {
  // 等待首次散列基线；应用启动时已有内容不属于新复制。
  await page.waitForTimeout(1200)
  const copied = `不能自动保存的过期内容-${Date.now()}`
  const before = await page.evaluate(() => window.jiwei.inbox.list().then((items) => items.length))
  await app.evaluate(async ({ clipboard }, text) => {
    await clipboard.writeText(text)
  }, copied)
  await page.waitForTimeout(1200)
  const capture = await open('text')
  await expect(capture.getByRole('button', { name: '粘贴剪贴板内容？' })).toBeVisible()
  await app.evaluate(() => {
    const clock = globalThis as typeof globalThis & { captureOriginalNow?: () => number }
    clock.captureOriginalNow = Date.now
    Date.now = () => clock.captureOriginalNow!() + 31_000
  })
  try {
    await capture.getByRole('button', { name: '粘贴剪贴板内容？' }).click()
    await expect(capture.getByText('剪贴板内容已超过 30 秒，请重新复制后打开捕捉。', { exact: true })).toBeVisible()
    await expect(capture.getByRole('button', { name: '粘贴剪贴板内容？' })).toHaveCount(0)
    await expect(capture.getByRole('textbox', { name: '捕捉内容' })).toHaveValue('')
    expect(await capture.evaluate(() => window.jiwei.inbox.list().then((items) => items.length))).toBe(before)
  } finally {
    await app.evaluate(() => {
      const clock = globalThis as typeof globalThis & { captureOriginalNow?: () => number }
      Date.now = clock.captureOriginalNow!
      delete clock.captureOriginalNow
    })
    await capture
      .evaluate(() => window.jiwei.capture.close())
      .catch((e) => {
        if (!capture.isClosed()) throw e
      })
  }
})

test('phone inline Chinese page uploads actual file even with English desktop locale', async () => {
  await page.evaluate(() => window.jiwei.settings.set({ language: 'en' }))
  const status = await page.evaluate(() => window.jiwei.phone.start())
  const nextWindow = app.waitForEvent('window')
  await app.evaluate(async ({ BrowserWindow }, url) => {
    const window = new BrowserWindow({ show: false })
    await window.loadURL(url)
  }, status.url)
  const phone = await nextWindow
  try {
    await expect(phone.getByRole('heading', { name: '上传到积微' })).toBeVisible()
    expect(await phone.locator('script[src],link[href],iframe').count()).toBe(0)
    await phone.getByRole('textbox', { name: '备注', exact: true }).fill('内联页实际上传备注')
    await phone.locator('#files').setInputFiles(fixture)
    await expect(phone.getByRole('status')).toHaveText('已收到')
    await expect(phone.locator('#received')).toContainText('fixture.jpg · 已收到')
    const item = await page.evaluate(() =>
      window.jiwei.inbox.list().then((items) => items.find((i) => i.text.includes('内联页实际上传备注')))
    )
    expect(item?.assetId).toMatch(/^[a-f0-9]{64}$/)
    expect(item?.origin.sessionId).toBe(status.sessionId)
  } finally {
    await phone.close()
    await page.evaluate(async (id) => {
      await window.jiwei.phone.stop(id)
      await window.jiwei.settings.set({ language: 'zh-CN' })
    }, status.sessionId)
  }
})
