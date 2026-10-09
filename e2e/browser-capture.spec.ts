import * as Y from 'yjs'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page, server: Server, base: string
const evidence = process.env.SHOTS_DIR
const boundsEvidence: unknown[] = []
const canvas = `<!doctype html><meta charset="utf-8"><title>画布阅读</title><canvas width="1000" height="800"></canvas><script>const c=document.querySelector('canvas'),x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,1000,800);x.fillStyle='#124';x.font='28px sans-serif';x.fillText('间隔重复让记忆保持更久',30,65);x.fillText('提取练习比反复重读更有效',30,130);</script>`
test.beforeAll(async () => {
  if (evidence) mkdirSync(evidence, { recursive: true })
  server = createServer((req, res) =>
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(req.url === '/login' ? '<input type="password">' : canvas)
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-browser-capture-'))}`],
    env: {
      ...process.env,
      JIWEI_LANG: 'zh-CN',
      JIWEI_SKIP_ONBOARDING: '1',
      JIWEI_IMPORT_PROVIDERS_FROM: process.env.JIWEI_IMPORT_PROVIDERS_FROM ?? ''
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      ai: { ...s.ai, recognition: { mode: 'off', auto: false, figures: false, providerId: null, model: null } }
    })
  })
  const size = process.env.JIWEI_TEST_WINDOW?.split('x').map(Number)
  if (size?.length === 2) await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), size)
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('画布摘抄验证')
  await page.getByRole('button', { name: '在笔记旁打开浏览器' }).click()
  await page
    .getByTestId('browser-start')
    .getByRole('textbox')
    .fill(base + '/canvas')
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => window.jiwei.browser.state().then((s) => s.tabs[0]?.loading))).toBe(false)
})
test.afterAll(async () => {
  await app?.close()
  server?.close()
  if (evidence) {
    mkdirSync(evidence, { recursive: true })
    writeFileSync(join(evidence, 'native-bounds.json'), JSON.stringify(boundsEvidence, null, 2))
  }
})
async function select(): Promise<void> {
  await page.getByRole('button', { name: '框选识别', exact: true }).click()
  const selection = page.getByTestId('browser-capture-selection')
  await expect(selection.locator('img')).toBeVisible()
  const b = (await selection.boundingBox())!
  await page.mouse.move(b.x + b.width * 0.05, b.y + b.height * 0.08)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width * 0.85, b.y + b.height * 0.4, { steps: 8 })
  await page.mouse.up()
  await expect(page.getByTestId('browser-recognition-card')).toBeVisible({ timeout: 120000 })
}
async function nativeBounds(): Promise<void> {
  const slot = (await page.getByTestId('browser-view').boundingBox())!
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const view = BrowserWindow.getAllWindows()[0].contentView.children[0]
        return view ? { bounds: view.getBounds(), visible: view.getVisible() } : null
      })
    )
    .toEqual({
      bounds: { x: Math.round(slot.x), y: Math.round(slot.y), width: Math.round(slot.width), height: Math.round(slot.height) },
      visible: true
    })
  boundsEvidence.push({
    slot,
    native: await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      return { window: win.getSize(), view: win.contentView.children[0].getBounds(), visible: win.contentView.children[0].getVisible() }
    })
  })
}
async function reachable(testId: string): Promise<void> {
  const area = page.getByTestId(testId)
  expect(await area.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  for (const button of await area.getByRole('button').all()) {
    await button.scrollIntoViewIfNeeded()
    const box = (await button.boundingBox())!
    const windowSize = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(windowSize.w + 1)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(windowSize.h + 1)
  }
}
test('retained frame pixels match crop after the live canvas changes; Electron 2x representations', async () => {
  const frame = await page.evaluate(() => window.jiwei.browser.captureBegin())
  await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http://127.0.0.1'))!
    await wc.executeJavaScript("document.querySelector('canvas').getContext('2d').fillRect(0,0,1000,800)")
  })
  const result = await page.evaluate((id) => window.jiwei.browser.captureRecognize(id, { x: 0.1, y: 0.1, w: 0.6, h: 0.4 }), frame.id)
  if (evidence) {
    mkdirSync(evidence, { recursive: true })
    writeFileSync(join(evidence, 'frozen-frame.png'), Buffer.from(frame.image.split(',')[1], 'base64'))
    writeFileSync(join(evidence, 'frozen-crop.png'), Buffer.from(result.image.split(',')[1], 'base64'))
  }
  const pixels = await app.evaluate(
    ({ nativeImage }, { full, crop }) => {
      const original = nativeImage.createFromDataURL(full),
        actual = nativeImage.createFromDataURL(crop)
      const { width, height } = original.getSize()
      const rect = {
        x: Math.floor(width * 0.1),
        y: Math.floor(height * 0.1),
        width: Math.ceil(width * 0.7) - Math.floor(width * 0.1),
        height: Math.ceil(height * 0.5) - Math.floor(height * 0.1)
      }
      const expected = original.crop(rect)
      // Electron 实际 2x 表示：编码位图与 DIP 尺寸不同，重建后的裁剪必须按像素计算。
      const high = nativeImage.createEmpty()
      high.addRepresentation({ scaleFactor: 2, buffer: original.toPNG() })
      const restored = nativeImage.createFromBuffer(high.toPNG({ scaleFactor: 2 }))
      return {
        actual: actual.getSize(),
        expected: expected.getSize(),
        same: expected.toBitmap().equals(actual.toBitmap()),
        scales: high.getScaleFactors(),
        dip: high.getSize(),
        restored: restored.getSize(),
        highSame: restored.crop(rect).toBitmap().equals(actual.toBitmap())
      }
    },
    { full: frame.image, crop: result.image }
  )
  expect(pixels.actual).toEqual(pixels.expected)
  expect(pixels.same).toBe(true)
  expect(pixels.scales).toContain(2)
  expect(pixels.restored.width).toBe(pixels.dip.width * 2)
  expect(pixels.highSame).toBe(true)
  await page.evaluate((id) => window.jiwei.browser.captureRelease(id), frame.id)
  await page.evaluate(() => window.jiwei.browser.state().then((s) => window.jiwei.browser.command(s.activeId!, 'reload')))
  await expect.poll(() => page.evaluate(() => window.jiwei.browser.state().then((s) => s.tabs[0]?.loading))).toBe(false)
})
test('real canvas region, edited excerpts, source/time and actual native bounds', async () => {
  test.setTimeout(180000)
  await select()
  const card = page.getByTestId('browser-recognition-card')
  await expect(card).toContainText('下载或启用本地识别模型')
  await card.getByRole('textbox', { name: '识别文字' }).fill('第一段：间隔重复让记忆保持更久。')
  await card.getByRole('button', { name: '问 AI', exact: true }).click()
  const answerCard = page.getByRole('dialog', { name: '就地答复' })
  await expect(answerCard).toBeVisible()
  if (!process.env.JIWEI_IMPORT_PROVIDERS_FROM) await expect(answerCard.getByAltText('框选提问')).toBeVisible()
  else
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const state = await window.jiwei.browser.state()
            const sourceId = state.tabs.find((t) => t.id === state.activeId)?.sourceId
            if (!sourceId) return ''
            const threads = await window.jiwei.chat.threads(sourceId)
            if (!threads.length) return ''
            const messages = await window.jiwei.chat.messages(threads[0].id)
            return messages.find((m) => m.role === 'assistant' && m.status === 'done')?.content ?? ''
          }),
        { timeout: 120000 }
      )
      .toMatch(/记忆|练习|间隔/)
  await page.keyboard.press('Escape')
  await reachable('browser-recognition-card')
  await nativeBounds()
  await card.getByRole('button', { name: '加入摘抄' }).click()
  await expect(page.getByTestId('browser-excerpt')).toHaveCount(1)
  await nativeBounds()
  // 已加入的摘抄跨导航保留，下一次自动加入同一面板。
  await page.evaluate((url) => window.jiwei.browser.state().then((s) => window.jiwei.browser.navigate(s.activeId!, url)), base + '/second')
  await expect(card).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.jiwei.browser.state().then((s) => s.tabs[0]?.loading))).toBe(false)
  await select()
  await card.getByRole('textbox', { name: '识别文字' }).fill('第二段：提取练习比反复重读更有效。')
  await expect(page.getByTestId('browser-excerpt')).toHaveCount(2)
  await reachable('browser-recognition-card')
  await reachable('browser-excerpts')
  await nativeBounds()
  if (evidence) {
    mkdirSync(evidence, { recursive: true })
    await page.screenshot({ path: join(evidence, 'browser-card-panel.png') })
  }
  await page.getByTestId('browser-excerpt').nth(1).getByRole('button', { name: '上移' }).click()
  await expect(page.getByTestId('browser-excerpt').first().getByRole('textbox')).toHaveValue(/第二段/)
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ browser: { ...s.browser, aiBlockedSites: ['127.0.0.1'] } })
  })
  await page.getByRole('button', { name: '合并存入笔记' }).click()
  await expect(page.getByText('网页已变化或不允许采集，请重新框选', { exact: false }).first()).toBeVisible()
  await expect(page.getByTestId('browser-excerpt')).toHaveCount(2)
  await expect(page.getByTestId('browser-excerpt').first().getByRole('textbox')).toHaveValue(/第二段/)
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ browser: { ...s.browser, aiBlockedSites: [] } })
  })
  await page.getByRole('button', { name: '合并存入笔记' }).click()
  await expect(page.getByTestId('browser-excerpt')).toHaveCount(0)
  const data = await page.evaluate(async () => {
    const notes = await window.jiwei.notes.list({})
    const n = notes.find((n) => n.title === '画布摘抄验证')!
    return Array.from(await window.jiwei.notes.loadDoc(n.id))
  })
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(data))
  const serialized = doc.getXmlFragment('default').toString()
  doc.destroy()
  expect(serialized).toContain('第一段')
  expect(serialized).toContain('第二段')
  expect(serialized).toContain(base + '/canvas')
  expect(serialized).toContain(base + '/second')
  expect(serialized).toContain('jiwei://source/')
  expect(serialized).toMatch(/\d{4}-\d{2}-\d{2}T/)
  expect(serialized.indexOf('第二段')).toBeLessThan(serialized.indexOf('第一段'))
  await page.getByTestId('browser-excerpts').getByRole('button', { name: '关闭', exact: true }).click()
  await nativeBounds()
})
test('same-page continuous capture preserves readable native width and fresh snapshot dimensions', async () => {
  const slot = page.getByTestId('browser-view')
  const baseline = (await slot.boundingBox())!
  await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http://127.0.0.1'))!
    await wc.executeJavaScript(`(() => {
      const c = document.querySelector('canvas'); c.height = 2000;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 1000, 2000);
      x.fillStyle = '#124'; x.font = '20px sans-serif'; x.fillText('同页第一段', 12, 65); x.fillText('同页第二段', 12, 445);
      x.fillStyle = '#00aa00'; x.fillRect(innerWidth - 60, 40, 40, 40);
      x.fillStyle = '#0000ff'; x.fillRect(innerWidth - 60, 420, 40, 40);
      scrollTo(0, 0);
    })()`)
  })
  const captureLine = async (color: 'green' | 'blue'): Promise<void> => {
    await page.getByRole('button', { name: '框选识别', exact: true }).click()
    const selection = page.getByTestId('browser-capture-selection')
    const img = selection.locator('img')
    await expect(img).toBeVisible()
    const box = (await selection.boundingBox())!
    const dimensions = await img.evaluate((node: HTMLImageElement) => ({
      width: node.naturalWidth,
      height: node.naturalHeight,
      src: node.src
    }))
    const native = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children[0].getBounds())
    // 冻结前先完成卡片关闭与原生视图 resize；图像不可拉伸旧高度或旧宽度。
    expect(native.width).toBe(Math.round(box.width))
    expect(native.height).toBe(Math.round(box.height))
    expect(dimensions.width / native.width).toBeCloseTo(dimensions.height / native.height, 2)
    expect(box.width).toBeGreaterThanOrEqual(baseline.width - 1)
    const coloredPixels = (src: string): Promise<number> =>
      app.evaluate(
        ({ nativeImage }, { src, color }) => {
          const image = nativeImage.createFromDataURL(src)
          const data = image.toBitmap()
          let count = 0
          for (let i = 0; i < data.length; i += 4)
            if (
              color === 'green'
                ? data[i] < 10 && data[i + 1] > 140 && data[i + 2] < 10
                : data[i] > 240 && data[i + 1] < 10 && data[i + 2] < 10
            )
              count++
          return count
        },
        { src, color }
      )
    const pixels = await coloredPixels(dimensions.src)
    expect(pixels).toBeGreaterThan(500)
    if (evidence) writeFileSync(join(evidence, `same-page-${color}-frame.png`), Buffer.from(dimensions.src.split(',')[1], 'base64'))
    await page.mouse.move(box.x + 10, box.y + 20)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 10, box.y + 100, { steps: 8 })
    await page.mouse.up()
    await expect(page.getByTestId('browser-recognition-card')).toBeVisible()
    const cropped = await page
      .getByTestId('browser-recognition-card')
      .getByAltText('框选图片')
      .evaluate((image: HTMLImageElement) => ({ src: image.src, width: image.naturalWidth, height: image.naturalHeight }))
    expect(await coloredPixels(cropped.src)).toBe(pixels)
    expect(cropped.width).toBeGreaterThan(((box.width - 22) * dimensions.width) / native.width)
    boundsEvidence.push({
      scenario: `same-page-${color}`,
      baseline,
      selection: box,
      native,
      frame: { width: dimensions.width, height: dimensions.height },
      crop: { width: cropped.width, height: cropped.height },
      coloredPixels: pixels
    })
    if (evidence) writeFileSync(join(evidence, `same-page-${color}-crop.png`), Buffer.from(cropped.src.split(',')[1], 'base64'))
  }
  await captureLine('green')
  const card = page.getByTestId('browser-recognition-card')
  await card.getByRole('textbox', { name: '识别文字' }).fill('同页第一段')
  // 卡片出现后网页保留原可读宽度，而不是仅剩 66px。
  await expect.poll(async () => (await slot.boundingBox())!.width).toBeGreaterThanOrEqual(baseline.width - 1)
  await card.getByRole('button', { name: '加入摘抄' }).click()
  await nativeBounds()
  await reachable('browser-recognition-card')
  await reachable('browser-excerpts')
  await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http://127.0.0.1'))!
    await wc.executeJavaScript('scrollTo(0, 380)')
  })
  // 卡片仍打开时，原生网页能显示完整第二段及右端标记；单独保存原生层，避免 renderer 截图漏掉网页。
  await expect
    .poll(() =>
      app.evaluate(async ({ webContents }) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http://127.0.0.1'))!
        const image = await wc.capturePage()
        const bytes = image.toBitmap()
        let blue = 0
        for (let i = 0; i < bytes.length; i += 4) if (bytes[i] > 240 && bytes[i + 1] < 10 && bytes[i + 2] < 10) blue++
        return blue
      })
    )
    .toBeGreaterThan(500)
  if (evidence) {
    const live = await app.evaluate(async ({ webContents }) =>
      (
        await webContents
          .getAllWebContents()
          .find((w) => w.getURL().startsWith('http://127.0.0.1'))!
          .capturePage()
      )
        .toPNG()
        .toString('base64')
    )
    writeFileSync(join(evidence, 'same-page-live-blue.png'), Buffer.from(live, 'base64'))
  }
  // 同页不关闭卡片、不导航，直接再框选；检验第二段右侧蓝色标记仍在完整采集范围内。
  await captureLine('blue')
  await card.getByRole('textbox', { name: '识别文字' }).fill('同页第二段')
  await expect(page.getByTestId('browser-excerpt')).toHaveCount(2)
  await expect.poll(async () => (await slot.boundingBox())!.width).toBeGreaterThanOrEqual(baseline.width - 1)
  await nativeBounds()
  await reachable('browser-recognition-card')
  await reachable('browser-excerpts')
  if (evidence) await page.screenshot({ path: join(evidence, 'same-page-card-panel.png') })
  await page.getByTestId('browser-excerpt').last().getByRole('button', { name: '删除', exact: true }).click()
  await page.getByTestId('browser-excerpt').last().getByRole('button', { name: '删除', exact: true }).click()
  await page.getByTestId('browser-excerpts').getByRole('button', { name: '关闭', exact: true }).click()
  await nativeBounds()
})
test('same-URL SPA navigation invalidates uncommitted frozen regions', async () => {
  const frame = await page.evaluate(() => window.jiwei.browser.captureBegin())
  await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http://127.0.0.1'))!
    await wc.executeJavaScript("history.replaceState({}, '', location.href)")
  })
  await expect
    .poll(() => page.evaluate(() => window.jiwei.browser.state().then((s) => s.tabs.find((t) => t.id === s.activeId)?.scope)))
    .not.toBe(frame.scope)
  expect(
    await page.evaluate(
      (id) =>
        window.jiwei.browser.captureRecognize(id, { x: 0, y: 0, w: 0.5, h: 0.5 }).then(
          () => false,
          () => true
        ),
      frame.id
    )
  ).toBe(true)
  await page.evaluate((id) => window.jiwei.browser.captureRelease(id), frame.id)
  await nativeBounds()
})
test('sensitive and incognito tabs refuse region capture', async () => {
  await page.evaluate((url) => window.jiwei.browser.state().then((s) => window.jiwei.browser.navigate(s.activeId!, url)), base + '/login')
  await expect(page.getByRole('button', { name: '框选识别', exact: true })).toBeDisabled()
  expect(
    await page.evaluate(() =>
      window.jiwei.browser.captureBegin().then(
        () => false,
        () => true
      )
    )
  ).toBe(true)
  await page.evaluate((url) => window.jiwei.browser.open(url, { newTab: true, incognito: true }), base + '/canvas')
  await expect(page.getByRole('button', { name: '框选识别', exact: true })).toBeDisabled()
  expect(
    await page.evaluate(() =>
      window.jiwei.browser.captureBegin().then(
        () => false,
        () => true
      )
    )
  ).toBe(true)
})

test('local OCR reads the real browser canvas', async () => {
  test.skip(process.env.JIWEI_OCR !== '1', 'requires installed local OCR')
  test.setTimeout(180000)
  await page.evaluate(async (url) => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      ai: { ...s.ai, recognition: { mode: 'local', auto: false, figures: false, providerId: null, model: null } }
    })
    await window.jiwei.browser.open(url, { newTab: true })
  }, base + '/ocr')
  await expect
    .poll(() => page.evaluate(() => window.jiwei.browser.state().then((s) => s.tabs.find((t) => t.id === s.activeId)?.loading)))
    .toBe(false)
  const frame = await page.evaluate(() => window.jiwei.browser.captureBegin())
  const result = await page.evaluate((id) => window.jiwei.browser.captureRecognize(id, { x: 0, y: 0, w: 0.98, h: 0.7 }), frame.id)
  expect(result.recognition?.text).toMatch(/记忆|练习/)
  if (evidence) writeFileSync(join(evidence, 'browser-ocr.json'), JSON.stringify(result.recognition, null, 2))
  await page.evaluate((id) => window.jiwei.browser.captureRelease(id), frame.id)
})
