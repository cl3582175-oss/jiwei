import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import type { Server } from 'http'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clickInPage as clickOf, inPage as inPageOf, pageAction as actionOf, startSite } from './fixtures/browserPage'

// 内置浏览器（v0.6.0）：打开网页、相关笔记旁注、网页中的选区浮条（真实鼠标点击）→ 存为资料 → 高亮 / 批注 / 就地提问，
// 弹出层盖住网页时暂停显示、下载自动导入资料库、敏感页面关闭 AI、AI 面板带上当前网页。
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let server: Server
let base = ''
const shots = process.env.SHOTS_DIR
const downloads = mkdtempSync(join(tmpdir(), 'jiwei-e2e-dl-'))

test.beforeAll(async () => {
  ;({ server, base } = await startSite())
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-browser-'))}`],
    env: {
      ...process.env,
      JIWEI_LANG: 'zh-CN',
      JIWEI_SKIP_ONBOARDING: '1',
      JIWEI_IMPORT_PROVIDERS_FROM: '',
      JIWEI_DOWNLOAD_DIR: downloads,
      JIWEI_TEST_LOGIN_BLOCK_HOSTS: '127.0.0.1'
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  // 模拟 CI 的小屏幕：JIWEI_TEST_WINDOW=1000x680
  const size = process.env.JIWEI_TEST_WINDOW?.split('x').map(Number)
  if (size?.length === 2) await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), size)
})
test.afterAll(async () => {
  await app?.close()
  server?.close()
})

const inPage = <T>(code: string): Promise<T> => inPageOf<T>(app, code)
const clickInPage = (x: number, y: number): Promise<void> => clickOf(app, x, y)
const pageAction = (text: string, action: string): Promise<void> => actionOf(app, text, action)

const tabs = () => page.evaluate(() => window.jiwei.browser.state())

test('a note to relate to; the browser opens beside it with a start page', async () => {
  test.setTimeout(300_000)
  await page.evaluate(() => window.jiwei.embedding.installLocal())
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('间隔重复')
  await page.keyboard.press('Enter')
  await page.keyboard.type('在快要遗忘的时候复习，复习间隔逐渐拉长，记忆保持得更久。')
  await expect
    .poll(
      async () => {
        const s = await page.evaluate(() => window.jiwei.embedding.status())
        return s.total > 0 && s.indexed === s.total
      },
      { timeout: 60_000 }
    )
    .toBe(true)

  await page.getByRole('button', { name: '在笔记旁打开浏览器' }).click()
  await expect(page.getByTestId('browser-pane')).toBeVisible()
  await expect(page.getByTestId('browser-start')).toBeVisible()
  await page.getByTestId('browser-start').getByRole('textbox').fill(`${base}/article`)
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await tabs()).tabs[0]?.title).toBe('间隔重复的原理')
  await expect(page.getByRole('textbox', { name: '地址栏' })).toHaveValue(`${base}/article`)
  // 笔记仍在右栏
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('间隔重复')
})

test('related notes are suggested from local vectors', async () => {
  await expect(page.getByTestId('browser-related')).toContainText('间隔重复', { timeout: 15_000 })
  if (shots) await page.screenshot({ path: join(shots, '200-browser.png') })
})

test('in-page toolbar: highlight saves the page as a source and paints the highlight', async () => {
  await pageAction('让记忆保持得更久', 'highlighting')
  await expect.poll(async () => (await tabs()).tabs[0]?.sourceId, { timeout: 10_000 }).toBeTruthy()
  const sourceId = (await tabs()).tabs[0].sourceId!
  await expect.poll(() => page.evaluate((id) => window.jiwei.annotations.list('source', id).then((l) => l.length), sourceId)).toBe(1)
  const [a] = await page.evaluate((id) => window.jiwei.annotations.list('source', id), sourceId)
  expect(a.selector.quote).toBe('让记忆保持得更久')
  expect(a.selector.prefix).toContain('复习，')
  // 网页上画出高亮（CSS Custom Highlight，不改动网页 DOM）
  await expect.poll(() => inPage<number>(`CSS.highlights.get('jw-yellow')?.size ?? 0`)).toBe(1)
  // 资料：网页快照分段，进入知识库
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.segments.list(id).then((s) => s.map((x) => x.text).join('')), sourceId))
    .toContain('提取练习')
  await expect(page.getByRole('button', { name: '已存为资料' })).toBeVisible()
})

test('comment from the page opens the annotation card beside the browser', async () => {
  await pageAction('比反复重读更有效', 'commenting')
  const card = page.getByTestId('annotation-card')
  await expect(card).toBeVisible()
  const [cb, vb] = await Promise.all([card.boundingBox(), page.getByTestId('browser-view').boundingBox()])
  expect(cb!.x).toBeGreaterThanOrEqual(vb!.x + vb!.width - 1)
  await card.getByRole('textbox').fill('考前用这个方法')
  await page.keyboard.press('ControlOrMeta+Enter')
  const sourceId = (await tabs()).tabs[0].sourceId!
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.annotations.list('source', id).then((l) => l.find((x) => x.body)?.body), sourceId))
    .toBe('考前用这个方法')
  // 网页上的高亮随之更新
  await expect.poll(() => inPage<number>(`CSS.highlights.get('jw-yellow')?.size ?? 0`)).toBe(2)
  // 截取网页视图本身（Playwright 的截图不含原生视图）
  if (shots) {
    const png = await app.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http://127.0.0.1'))!
      return (await wc.capturePage()).toPNG().toString('base64')
    })
    writeFileSync(join(shots, '202-browser-view.png'), Buffer.from(png, 'base64'))
  }
})

test('ask AI from the page: the answer card docks beside the browser; overlays freeze the page', async () => {
  await pageAction('提取练习', 'ask')
  const card = page.getByRole('dialog', { name: '就地答复' })
  await expect(card).toBeVisible()
  const [cb, vb] = await Promise.all([card.boundingBox(), page.getByTestId('browser-view').boundingBox()])
  const room = (await page.evaluate(() => window.innerWidth)) - (vb!.x + vb!.width)
  // 浏览器右侧放得下卡片：停靠在右侧，网页照常显示
  if (room >= 432) expect(cb!.x).toBeGreaterThanOrEqual(vb!.x + vb!.width - 1)
  else await expect(page.getByTestId('browser-view').locator('img')).toBeVisible()
  if (shots) await page.screenshot({ path: join(shots, '201-browser-ask.png') })
  await page.keyboard.press('Escape')
  // 窗口较窄（右侧放不下卡片）：卡片盖住网页时，网页换成截图，卡片照常可见
  const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700))
  await pageAction('提取练习', 'ask')
  await expect(card).toBeVisible()
  await expect(page.getByTestId('browser-view').locator('img')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('browser-view').locator('img')).toHaveCount(0)
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), size)
  // 命令面板盖住网页：网页换成截图，关闭后恢复
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByTestId('browser-view').locator('img')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('browser-view').locator('img')).toHaveCount(0)
})

test('the AI panel sees the current page', async () => {
  await page.keyboard.press('ControlOrMeta+j')
  await expect(page.getByRole('complementary', { name: /AI/ })).toContainText('间隔重复的原理')
  await page.keyboard.press('ControlOrMeta+j')
})

test('downloads are imported into the library', async () => {
  // 小屏幕上链接可能在可见区域之外：先滚动到可见处
  const r = await inPage<{ x: number; y: number }>(
    `(() => { const a = document.getElementById('dl'); a.scrollIntoView({ block: 'center' }); const b = a.getBoundingClientRect(); return { x: b.left + 5, y: b.top + 5 } })()`
  )
  await clickInPage(r.x, r.y)
  await expect(page.getByText('已下载并导入资料库：lecture.pdf')).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => page.evaluate(() => window.jiwei.sources.list({}).then((s) => s.map((x) => x.title)))).toContain('lecture')
})

test('sensitive pages turn AI off: no toolbar, cannot be saved', async () => {
  await page.getByRole('textbox', { name: '地址栏' }).fill(`${base}/login`)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('ai-off')).toBeVisible({ timeout: 10_000 })
  await inPage(`(() => {
    const n = document.querySelector('p').firstChild
    const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 6)
    getSelection().removeAllRanges(); getSelection().addRange(r)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })()`)
  await page.waitForTimeout(500)
  expect(await inPage<string | null>(`document.querySelector('jiwei-toolbar')?.getAttribute('data-buttons') ?? null`)).toBeNull()
  await expect(page.evaluate(() => window.jiwei.browser.saveSource(null))).rejects.toThrow(/不发送给 AI/)
  // 浏览器中的网页不能调用积微的接口（只有约定的内容脚本消息）
  const forbidden = await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('/login'))!
    return wc.executeJavaScript(`typeof window.jiwei === 'undefined' && typeof window.require === 'undefined'`)
  })
  expect(forbidden).toBe(true)
})

test('a hidden login form does not turn AI off until it is actually shown', async () => {
  await page.getByRole('textbox', { name: '地址栏' }).fill(`${base}/hidden-login`)
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await tabs()).tabs.find((t) => t.url.endsWith('/hidden-login'))?.title).toBe('带隐藏登录框的课程页')
  await page.waitForTimeout(800)
  await expect(page.getByTestId('ai-off')).toHaveCount(0)
  await app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL().includes('/hidden-login'))!
    await wc.executeJavaScript(`document.getElementById('modal').style.display = 'block'`)
  })
  await expect(page.getByTestId('ai-off')).toBeVisible({ timeout: 10_000 })
})

test('a page that fails to load shows a reason and a reload button instead of a blank pane', async () => {
  const address = page.getByRole('textbox', { name: '地址栏' })
  await address.fill('http://127.0.0.1:9/unreachable')
  await address.press('Enter')
  await expect
    .poll(() =>
      app.evaluate(async ({ webContents }) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith('http://127.0.0.1:9/'))
        return wc ? ((await wc.executeJavaScript('document.body ? document.body.innerText : ""')) as string) : ''
      })
    )
    .toContain('无法打开这个网页')
})

test('closing the last tab closes the browser', async () => {
  await page.getByRole('button', { name: /关闭标签页/ }).click()
  await expect(page.getByTestId('browser-pane')).toHaveCount(0)
  expect((await tabs()).tabs).toHaveLength(0)
})

test('登录受阻引导使用进入登录前的网址，始终外部打开可以撤销', async () => {
  const id = await page.evaluate((base) => window.jiwei.browser.open(base + '/article', { newTab: true }), base)
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.browser.state().then((s) => s.tabs.find((t) => t.id === id)?.title), id))
    .toBe('间隔重复的原理')
  await app.evaluate(({ shell }) => {
    const urls: string[] = []
    ;(globalThis as typeof globalThis & { safetyExternalUrls?: string[] }).safetyExternalUrls = urls
    shell.openExternal = async (url) => {
      urls.push(url)
    }
  })
  await page.evaluate(({ id, url }) => window.jiwei.browser.navigate(id, url), { id, url: base + '/signin/rejected' })
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.browser.state().then((s) => s.tabs.find((t) => t.id === id)?.loginBlocked?.url), id))
    .toBe(base + '/article')
  await page.evaluate((id) => window.jiwei.browser.openExternal(id), id)
  expect(await app.evaluate(() => (globalThis as typeof globalThis & { safetyExternalUrls: string[] }).safetyExternalUrls)).toEqual([
    base + '/article'
  ])
  await page.evaluate(() => window.jiwei.browser.externalSite('127.0.0.1', true))
  const before = (await tabs()).tabs.find((t) => t.id === id)!.url
  await page.evaluate(({ id, base }) => window.jiwei.browser.navigate(id, base + '/article'), { id, base })
  expect((await tabs()).tabs.find((t) => t.id === id)!.url).toBe(before)
  await page.evaluate(() => window.jiwei.browser.externalSite('127.0.0.1', false))
  await page.evaluate(({ id, base }) => window.jiwei.browser.navigate(id, base + '/article'), { id, base })
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.browser.state().then((s) => s.tabs.find((t) => t.id === id)?.title), id))
    .toBe('间隔重复的原理')
  await page.evaluate((id) => window.jiwei.browser.close(id), id)
})
test('网站网络持久化且只影响内置浏览器，域名和子域名返回 DIRECT', async () => {
  const before = await app.evaluate(({ session }) => session.defaultSession.resolveProxy('https://www.bilibili.com/'))
  await page.evaluate(() =>
    window.jiwei.browser.networkRules([
      { domain: 'bilibili.com', mode: 'direct' },
      { domain: 'bilivideo.com', mode: 'direct' }
    ])
  )
  expect(
    await app.evaluate(({ session }) => session.fromPartition('persist:jiwei-browser').resolveProxy('https://www.bilibili.com/'))
  ).toBe('DIRECT')
  expect(
    await app.evaluate(({ session }) => session.fromPartition('persist:jiwei-browser').resolveProxy('https://upos.bilivideo.com/'))
  ).toBe('DIRECT')
  expect(await app.evaluate(({ session }) => session.defaultSession.resolveProxy('https://www.bilibili.com/'))).toBe(before)
  expect((await page.evaluate(() => window.jiwei.settings.get())).browser?.networkRules?.length).toBe(2)
  await page.evaluate(() => window.jiwei.browser.networkRules([]))
})

test('读取网站网络状态不会打断正在接收的网页请求', async () => {
  const id = await page.evaluate((base) => window.jiwei.browser.open(base + '/article', { newTab: true }), base)
  await expect
    .poll(() => page.evaluate((id) => window.jiwei.browser.state().then((s) => s.tabs.find((t) => t.id === id)?.title), id))
    .toBe('间隔重复的原理')
  await page.evaluate(() => window.jiwei.browser.networkStatus())
  await inPage(`(() => {
    window.safetyNetworkResult = 'pending';
    fetch('/slow-network-status').then(r => r.text()).then(text => window.safetyNetworkResult = text, e => window.safetyNetworkResult = e.message);
    return true;
  })()`)
  await page.evaluate(() => window.jiwei.browser.networkStatus())
  await page.evaluate(() => window.jiwei.browser.networkStatus())
  await expect.poll(() => inPage<string>('window.safetyNetworkResult')).toBe('firstlast')
})

test('1000×680 登录引导正文至少 14px，长操作换行且不横向溢出', async () => {
  const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
  const theme = (await page.evaluate(() => window.jiwei.settings.get())).theme
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
    await page.keyboard.press('ControlOrMeta+n')
    await page.getByPlaceholder('笔记标题').fill('窄窗登录引导验收')
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: '在笔记旁打开浏览器' }).click()
    const id = await page.evaluate((base) => window.jiwei.browser.open(base + '/signin/rejected', { newTab: true }), base)
    const bar = page.getByTestId('browser-login-warning')
    await expect(bar).toBeVisible()
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((theme) => window.jiwei.settings.set({ theme }), theme)
      await expect
        .poll(() =>
          bar.evaluate((el) => ({
            font: parseFloat(getComputedStyle(el).fontSize),
            overflow: el.scrollWidth > el.clientWidth + 1,
            buttonOverflow: [...el.querySelectorAll('button')].some((b) => b.scrollWidth > b.clientWidth + 1)
          }))
        )
        .toEqual({ font: 14, overflow: false, buttonOverflow: false })
      // 地址栏不能被网络菜单等按钮挤到换行或只剩几个字符（v0.6.6 审查发现）。
      await expect(page.getByTestId('website-network')).toBeVisible()
      expect(await page.getByTestId('browser-address').evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(160)
      if (shots) await page.screenshot({ path: join(shots, `browser-login-warning-${theme}-1000x680.png`), animations: 'disabled' })
    }
    await page.evaluate((id) => window.jiwei.browser.close(id), id)
  } finally {
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), size)
    await page.evaluate((theme) => window.jiwei.settings.set({ theme }), theme)
  }
})
