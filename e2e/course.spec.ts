import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readdirSync, statSync } from 'fs'
import type { Server } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import * as Y from 'yjs'
import type { BrowserTab, DocNode, Proposal, Segment } from '../src/shared/types'
import { clickInPage, inPage } from './fixtures/browserPage'
import {
  COURSE_BODY,
  COURSE_CUES,
  COURSE_TITLE,
  courseView,
  inCoursePage,
  makeCourseMedia,
  startCourseSite,
  timestampShortcut
} from './fixtures/coursePage'

// 在线网课：真实原生网页、字幕、关键帧、时间点与隐私；模型能力仅在显式开启实机环境时运行。
test.skip(process.platform !== 'darwin', '测试素材需要 macOS 的 say -v Tingting')

interface Harness {
  app: ElectronApplication
  page: Page
  userData: string
}
let main: Harness
let server: Server
let base = ''
let courseId = ''
let noteId = ''
const mediaDir = mkdtempSync(join(tmpdir(), 'jiwei-e2e-course-media-'))
const providers = process.env.JIWEI_IMPORT_PROVIDERS_FROM
const shots = process.env.SHOTS_DIR
const panel = (h = main) => h.page.getByTestId('course-panel')
const transcript = (h = main) => h.page.getByTestId('course-transcript')
const answer = (h = main) => h.page.getByRole('dialog', { name: '就地答复' })

async function launch(withProviders = false): Promise<Harness> {
  const userData = mkdtempSync(join(tmpdir(), 'jiwei-e2e-course-'))
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      JIWEI_LANG: 'zh-CN',
      JIWEI_SKIP_ONBOARDING: '1',
      JIWEI_IMPORT_PROVIDERS_FROM: withProviders ? (providers ?? '') : ''
    }
  })
  // 实机模型可使用已校验的隔离缓存，不让安装/删除测试改动用户全局模型。
  if (process.env.JIWEI_TEST_MODELS_ROOT)
    await app.evaluate(({ app }, root) => app.setPath('appData', root), process.env.JIWEI_TEST_MODELS_ROOT)
  const page = await app.firstWindow()
  await page.waitForSelector('nav')
  const size = process.env.JIWEI_TEST_WINDOW?.split('x').map(Number)
  if (size?.length === 2) await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), size)
  return { app, page, userData }
}

const state = (h = main) => h.page.evaluate(() => window.jiwei.browser.state())
async function active(h = main): Promise<BrowserTab> {
  const s = await state(h)
  const tab = s.tabs.find((t) => t.id === s.activeId)
  if (!tab) throw new Error('No active course tab')
  return tab
}
async function expand(h = main): Promise<void> {
  const button = panel(h).getByRole('button', { name: '展开课程面板' })
  if (await button.isVisible()) await button.click()
}
async function navigate(path: string, h = main): Promise<void> {
  const current = (await active(h)).url
  const address = h.page.getByRole('textbox', { name: '地址栏' })
  // 主进程状态广播有节流，新标签页须等地址栏真正切换后再输入。
  await expect(address).toHaveValue(current === 'about:blank' ? '' : current)
  await address.fill(`${base}${path}`)
  await address.press('Enter')
  await expect.poll(() => active(h).then((t) => t.url)).toBe(`${base}${path}`)
}
async function ready(h = main): Promise<void> {
  await expect.poll(() => active(h).then((t) => t.video?.duration), { timeout: 15_000 }).toBeCloseTo(40, 0)
  await expect(panel(h)).toBeVisible()
  await expand(h)
}
async function createNote(title: string, h = main): Promise<string> {
  await h.page.keyboard.press('ControlOrMeta+n')
  await h.page.getByPlaceholder('笔记标题').fill(title)
  await h.page.keyboard.press('Enter')
  await h.page.keyboard.type('学习后用自己的话回忆。')
  await expect.poll(() => h.page.evaluate((title) => window.jiwei.notes.list({ search: title }).then((n) => n.length), title)).toBe(1)
  return h.page.evaluate((title) => window.jiwei.notes.list({ search: title }).then((n) => n[0].id), title)
}
async function freshCourse(path: string, h = main): Promise<void> {
  if (!(await h.page.getByTestId('browser-pane').isVisible())) await h.page.getByRole('button', { name: '在笔记旁打开浏览器' }).click()
  const start = h.page.getByTestId('browser-start')
  if (await start.isVisible()) {
    await start.getByRole('textbox').fill(`${base}${path}`)
    await h.page.keyboard.press('Enter')
  } else {
    await navigate('/empty', h)
    await expect(panel(h)).toHaveCount(0)
    await navigate(path, h)
  }
  await ready(h)
}
async function segments(h = main): Promise<Segment[]> {
  const id = (await active(h)).sourceId
  return id ? h.page.evaluate((id) => window.jiwei.segments.list(id), id) : []
}
async function savedNote(id: string, h = main): Promise<string> {
  const bytes = await h.page.evaluate((id) => window.jiwei.notes.loadDoc(id).then((bytes) => Array.from(bytes)), id)
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, new Uint8Array(bytes))
    return doc.getXmlFragment('default').toString()
  } finally {
    doc.destroy()
  }
}
async function playThrough(t: number, h = main): Promise<void> {
  const url = (await active(h)).url
  await inCoursePage(h.app, url, 'document.querySelector("video").play()')
  await expect
    .poll(() => inCoursePage<number>(h.app, url, 'document.querySelector("video").currentTime'), { timeout: 50_000, intervals: [500] })
    .toBeGreaterThanOrEqual(t)
  await inCoursePage(h.app, url, 'document.querySelector("video").pause()')
}
const audioFiles = (h = main): string[] => {
  const dir = join(h.userData, 'course-audio')
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

test.beforeAll(async () => {
  test.setTimeout(720_000)
  main = await launch()
  await makeCourseMedia(main.page, mediaDir)
  ;({ server, base } = await startCourseSite(mediaDir))
})
test.afterAll(async () => {
  await main?.app.close()
  await new Promise<void>((resolve) => {
    if (server) {
      server.close(() => resolve())
      server.closeAllConnections()
    } else resolve()
  })
})

test.describe('默认网课路径（无模型服务商）', () => {
  test.describe.configure({ mode: 'serial' })

  test('1. 打开课程：原生视频状态与课程面板时间一致', async () => {
    noteId = await createNote('在线网课笔记')
    await freshCourse('/course')
    const tab = await active()
    courseId = tab.id
    expect(tab.title).toBe(COURSE_TITLE)
    expect(tab.video).toMatchObject({ paused: true, rate: 1 })
    expect(tab.video!.currentTime).toBeLessThan(0.5)
    expect(Date.now() - tab.video!.updatedAt).toBeLessThan(10_000)
    await expect(panel()).toContainText('0:40')
    expect(await inPage<number>(main.app, 'document.querySelector("video").duration')).toBeCloseTo(40, 0)
    expect((await courseView(main.app, `${base}/course`))?.visible).toBe(true)
    expect(await main.page.evaluate(() => window.jiwei.providers.list())).toHaveLength(0)
  })

  test('2. 平台字幕写入真实分段，网页正文仍在并可检索', async () => {
    await expect(transcript()).toContainText('第一讲，间隔重复', { timeout: 15_000 })
    await expect(transcript()).toContainText('第二讲，提取练习')
    await expect.poll(() => segments().then((s) => s.filter((x) => x.kind === 'transcript').length)).toBe(COURSE_CUES.length)
    const all = await segments()
    expect(
      all
        .filter((s) => s.kind !== 'transcript')
        .map((s) => s.text)
        .join('')
    ).toContain(COURSE_BODY)
    expect(all.filter((s) => s.kind === 'transcript').map((s) => s.locator.value)).toEqual(COURSE_CUES.map((c) => `t=${c.start},${c.end}`))
    const sourceId = (await active()).sourceId!
    await expect
      .poll(() =>
        main.page.evaluate(
          (id) => window.jiwei.segments.search('提取练习', id).then((s) => s.some((x) => x.kind === 'transcript')),
          sourceId
        )
      )
      .toBe(true)
    // 导航离开再返回，字幕取自同一份持久资料，不重复创建或覆盖正文。
    await navigate('/empty')
    await navigate('/course')
    await ready()
    await expect.poll(() => active().then((t) => t.sourceId)).toBe(sourceId)
    expect((await segments()).filter((s) => s.kind === 'transcript')).toHaveLength(COURSE_CUES.length)
  })

  test('3. 真实播放到第二页：保存两张幻灯片并显示可跳转缩略图', async () => {
    test.setTimeout(55_000)
    await playThrough(25)
    await expect(main.page.getByTestId('course-slide')).toHaveCount(2, { timeout: 15_000 })
    const slides = (await segments()).filter((s) => s.kind === 'slide')
    expect(slides).toHaveLength(2)
    expect(slides.every((s) => typeof s.locator.image === 'string' && !!s.locator.image)).toBe(true)
    const times = slides.map((s) => Number(String(s.locator.value).slice(2)))
    expect(times[0]).toBeLessThan(20)
    expect(times[1]).toBeGreaterThanOrEqual(20)
    await expect
      .poll(() =>
        main.page
          .getByTestId('course-slide')
          .locator('img')
          .evaluateAll((imgs) => imgs.every((img) => (img as HTMLImageElement).naturalWidth > 0))
      )
      .toBe(true)
    await main.page.getByTestId('course-slide').first().click()
    await expect
      .poll(() => inPage<number>(main.app, 'document.querySelector("video").currentTime').then((t) => Math.abs(t - times[0])))
      .toBeLessThanOrEqual(1.5)
    if (shots) await main.page.screenshot({ path: join(shots, '210-course-slides.png') })
  })

  test('4. 播放中新增笔记行：时间点落库，点击后原生视频跳回', async () => {
    await main.page.evaluate((id) => window.jiwei.browser.seek(id, 26, true), courseId)
    await expect.poll(() => active().then((t) => t.video?.paused)).toBe(false)
    await main.page.locator('.cornell-row .cornell-body p').last().click()
    await main.page.keyboard.press('ControlOrMeta+Enter')
    await main.page.keyboard.type('复习时先合上书再自测。')
    const row = main.page.locator('.cornell-row').last()
    const link = row.getByRole('link', { name: /▶ 0:\d{2}/ })
    await expect(link).toBeVisible()
    await expect(row.locator('.cornell-body')).toContainText('复习时先合上书再自测。')
    const href = (await link.getAttribute('href'))!
    expect(href).toMatch(new RegExp(`^jiwei://source/${(await active()).sourceId}\\?t=\\d+`))
    await expect.poll(() => savedNote(noteId)).toContain(href)
    await expect.poll(() => savedNote(noteId)).toContain('复习时先合上书再自测。')
    await main.page.evaluate((id) => window.jiwei.browser.seek(id, 2, false), courseId)
    await expect.poll(() => active().then((t) => t.video?.currentTime)).toBeLessThan(3)
    await link.click()
    const t = Number(new URL(href).searchParams.get('t'))
    await expect
      .poll(() => inPage<number>(main.app, 'document.querySelector("video").currentTime').then((now) => Math.abs(now - t)))
      .toBeLessThanOrEqual(1.5)
    expect((await state()).tabs).toHaveLength(1)
    await inPage(main.app, 'document.querySelector("video").pause()')
  })

  test('5. 焦点在网页时 ⌘⇧T 插入时间点，不新开无痕标签', async () => {
    await main.page.locator('.cornell-row .cornell-body p').last().click()
    await main.page.keyboard.press('End')
    await main.page.evaluate((id) => window.jiwei.browser.seek(id, 12, false), courseId)
    await expect.poll(() => active().then((t) => t.video?.currentTime)).toBeCloseTo(12, 0)
    const links = main.page.locator('.cornell-doc a[href^="jiwei://source/"]')
    const count = await links.count()
    await clickInPage(main.app, 20, 20)
    await timestampShortcut(main.app, `${base}/course`)
    await expect(links).toHaveCount(count + 1)
    const href = (await links.last().getAttribute('href'))!
    expect(Number(new URL(href).searchParams.get('t'))).toBeCloseTo(12, 0)
    await expect.poll(() => savedNote(noteId)).toContain(href)
    expect((await state()).tabs).toHaveLength(1)
    expect((await active()).incognito).toBe(false)
  })

  test('6. 没有模型时仍打开没听懂卡片，并提示设置模型', async () => {
    await panel().getByRole('button', { name: '没听懂', exact: true }).click()
    await expect(answer()).toBeVisible()
    await expect(answer().getByRole('img', { name: '框选提问' })).toBeVisible()
    await expect(main.page.getByText('请先选择模型', { exact: true })).toBeVisible()
    await expect(main.page.getByRole('button', { name: '去设置模型服务' })).toBeVisible()
    await expect.poll(() => active().then((t) => t.video?.paused)).toBe(true)
    await main.page.keyboard.press('Escape')
    await expect(answer()).toHaveCount(0)
  })

  test('7. 小窗口默认收起；展开缩小原生网页，答复卡片不被遮挡', async () => {
    const previous = await main.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize())
    try {
      await main.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
      await navigate('/empty')
      await expect(panel()).toHaveCount(0)
      await navigate('/course')
      await expect(panel().getByRole('button', { name: '展开课程面板' })).toBeVisible()
      const collapsed = await courseView(main.app, `${base}/course`)
      expect(collapsed?.visible).toBe(true)
      await expand()
      await expect.poll(() => courseView(main.app, `${base}/course`).then((r) => r?.height ?? 0)).toBeLessThan(collapsed!.height - 30)
      const expanded = (await courseView(main.app, `${base}/course`))!
      const bounds = (await panel().boundingBox())!
      expect(expanded.y + expanded.height).toBeLessThanOrEqual(bounds.y + 2)
      await panel().getByRole('button', { name: '没听懂', exact: true }).click()
      await expect(answer()).toBeVisible()
      const card = (await answer().boundingBox())!
      const window = await main.page.evaluate(() => ({ w: innerWidth, h: innerHeight }))
      expect(card.x).toBeGreaterThanOrEqual(0)
      expect(card.y).toBeGreaterThanOrEqual(0)
      expect(card.x + card.width).toBeLessThanOrEqual(window.w)
      expect(card.y + card.height).toBeLessThanOrEqual(window.h)
      // 覆盖原生区域时，真实 WebContentsView 隐藏并显示截图占位。
      const overlaps =
        card.x < expanded.x + expanded.width &&
        card.x + card.width > expanded.x &&
        card.y < expanded.y + expanded.height &&
        card.y + card.height > expanded.y
      if (overlaps) {
        await expect(main.page.getByTestId('browser-view').locator('img')).toBeVisible()
        await expect.poll(() => courseView(main.app, `${base}/course`).then((v) => v?.visible)).toBe(false)
      }
      if (shots) await main.page.screenshot({ path: join(shots, '211-course-small-window.png') })
      await main.page.keyboard.press('Escape')
      await expect.poll(() => courseView(main.app, `${base}/course`).then((v) => v?.visible)).toBe(true)
    } finally {
      await main.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), previous)
    }
  })

  test('7b. 动态移除和替换主视频时撤销旧面板，并重新获取字幕', async () => {
    const tab = await active()
    const oldMedia = tab.video!.mediaId
    const markup = await inCoursePage<string>(main.app, tab.url, 'document.querySelector("video").outerHTML')
    await inCoursePage(main.app, tab.url, 'document.querySelector("video").remove()')
    await expect.poll(() => active().then((t) => t.video)).toBeNull()
    await expect(panel()).toHaveCount(0)
    await inCoursePage(main.app, tab.url, `document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(markup)})`)
    await ready()
    expect((await active()).video!.mediaId).not.toBe(oldMedia)
    await expect(transcript()).toContainText('第一讲，间隔重复')
    await main.page.evaluate((id) => window.jiwei.course.configure(id, { mode: 'off' }), tab.id)
    await expect.poll(() => active().then((t) => t.course.transcript)).toBe('off')
    await main.page.evaluate((id) => window.jiwei.course.configure(id, { mode: 'auto' }), tab.id)
    await expect.poll(() => active().then((t) => t.course.transcript)).toBe('captions')
  })

  test('7c. 分P先改网址时不采集旧视频，新媒体就绪后再保存新资料', async () => {
    const first = await active()
    await inCoursePage(main.app, first.url, "history.pushState({}, '', '/course?p=2')")
    await expect.poll(() => active().then((t) => t.url)).toBe(`${base}/course?p=2`)
    await expect(panel()).toHaveCount(0)
    // 旧视频仍在播放，也不能用它的字幕/幻灯片生成第二P资料。
    await inCoursePage(main.app, `${base}/course?p=2`, 'document.querySelector("video").play()')
    await expect
      .poll(() => inCoursePage<number>(main.app, `${base}/course?p=2`, 'document.querySelector("video").currentTime'))
      .toBeGreaterThan(1)
    expect((await active()).sourceId).toBeNull()
    await inCoursePage(
      main.app,
      `${base}/course?p=2`,
      'document.querySelector("video").pause(); document.querySelector("video").replaceWith(document.querySelector("video").cloneNode(true))'
    )
    await ready()
    await expect(transcript()).toContainText('第一讲，间隔重复')
    expect((await active()).sourceId).not.toBe(first.sourceId)
  })

  test('7d. 文字稿高亮在收起再展开后仍可点击，选区带真实时间锚点', async () => {
    await expand()
    await transcript()
      .locator('[data-segment]')
      .first()
      .evaluate((el) => {
        const node = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.includes('间隔重复'))!
        const range = document.createRange()
        const start = node.textContent!.indexOf('间隔重复')
        range.setStart(node, start)
        range.setEnd(node, start + 4)
        getSelection()!.removeAllRanges()
        getSelection()!.addRange(range)
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      })
    await main.page.getByRole('toolbar', { name: '选区操作' }).getByRole('button', { name: '高亮', exact: true }).click()
    const sourceId = (await active()).sourceId!
    await expect
      .poll(() => main.page.evaluate((id) => window.jiwei.annotations.list('source', id).then((xs) => xs.length), sourceId))
      .toBe(1)
    const [annotation] = await main.page.evaluate((id) => window.jiwei.annotations.list('source', id), sourceId)
    expect(annotation.selector.t).toEqual([0, 9])
    await panel().getByRole('button', { name: '收起课程面板' }).click()
    await expand()
    await expect.poll(() => main.page.evaluate(() => CSS.highlights.get('jw-yellow')?.size ?? 0)).toBe(1)
    const point = await main.page.evaluate(() => {
      const range = [...CSS.highlights.get('jw-yellow')!][0]
      if (!(range instanceof Range)) throw new Error('Highlight is not a live text range')
      const r = range.getClientRects()[0]
      getSelection()!.removeAllRanges()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })
    await main.page.mouse.click(point.x, point.y)
    await expect(main.page.getByTestId('annotation-card')).toBeVisible()
    await main.page.keyboard.press('Escape')
  })

  test('7e. 等待视频的时间点不能跳到随后导航的另一课程', async () => {
    await navigate('/empty')
    await main.page.evaluate((id) => window.jiwei.browser.seek(id, 28, true), courseId)
    await inCoursePage(main.app, `${base}/empty`, "location.assign('/course?next=1')")
    await ready()
    expect((await active()).video!.currentTime).toBeLessThan(2)
    expect((await active()).video!.paused).toBe(true)
  })

  test('8. 敏感页面和无痕标签页不采集视频、字幕、截图或录音', async () => {
    test.setTimeout(45_000)
    const sources = await main.page.evaluate(() => window.jiwei.sources.list({}).then((s) => s.map((x) => x.id).sort()))
    const recordings = audioFiles()
    await navigate('/login/course')
    await expect.poll(() => active().then((t) => t.sensitive)).toBe(true)
    await expect(panel()).toHaveCount(0)
    await inCoursePage(main.app, `${base}/login/course`, 'document.querySelector("video").play()')
    await expect
      .poll(() => inCoursePage<number>(main.app, `${base}/login/course`, 'document.querySelector("video").currentTime'), {
        timeout: 10_000
      })
      .toBeGreaterThan(5)
    expect((await active()).video).toBeNull()
    expect((await active()).sourceId).toBeNull()
    await expect(main.page.evaluate(() => window.jiwei.browser.saveSource(null))).rejects.toThrow()
    await inCoursePage(main.app, `${base}/login/course`, 'document.querySelector("video").pause()')
    await main.page.keyboard.press('ControlOrMeta+Shift+n')
    await expect.poll(() => active().then((t) => t.incognito)).toBe(true)
    await navigate('/course')
    await inCoursePage(main.app, `${base}/course`, 'document.querySelector("video").play()')
    await expect
      .poll(() => inCoursePage<number>(main.app, `${base}/course`, 'document.querySelector("video").currentTime'), { timeout: 10_000 })
      .toBeGreaterThan(5)
    const privateTab = await active()
    expect(privateTab.video).toBeNull()
    expect(privateTab.sourceId).toBeNull()
    await expect(panel()).toHaveCount(0)
    await expect(main.page.evaluate((id) => window.jiwei.course.snapshot(id), privateTab.id)).resolves.toBeNull()
    expect(await main.page.evaluate(() => window.jiwei.sources.list({}).then((s) => s.map((x) => x.id).sort()))).toEqual(sources)
    expect(audioFiles()).toEqual(recordings)
    expect(
      await inCoursePage<boolean>(
        main.app,
        `${base}/course`,
        'typeof window.jiwei === "undefined" && typeof window.require === "undefined"'
      )
    ).toBe(true)
    for (const tab of (await state()).tabs) await main.page.evaluate((id) => window.jiwei.browser.close(id), tab.id)
  })
})

test.describe('本地模型实机路径', () => {
  test('ASR：无字幕网页采集真实声音并落库文字稿', async () => {
    test.skip(process.env.JIWEI_ASR !== '1', '设置 JIWEI_ASR=1 下载并运行真实 SenseVoice')
    test.setTimeout(720_000)
    await main.page.evaluate(() => window.jiwei.asr.install())
    await expect.poll(() => main.page.evaluate(() => window.jiwei.asr.status().then((s) => s.state)), { timeout: 540_000 }).toBe('ready')
    if (!noteId) noteId = await createNote('在线网课模型实测')
    await freshCourse('/course-nosub')
    await expect.poll(() => active().then((t) => t.course.transcript)).toBe('local')
    await playThrough(35)
    await expect(transcript()).toContainText('间隔重复', { timeout: 120_000 })
    await expect(transcript()).toContainText('提取练习', { timeout: 120_000 })
    const all = await segments()
    expect(all.filter((s) => s.kind === 'transcript').length).toBeGreaterThan(0)
    expect(
      all
        .filter((s) => s.kind !== 'transcript')
        .map((s) => s.text)
        .join('')
    ).toContain(COURSE_BODY)
    expect(audioFiles().some((name) => name.endsWith('.webm'))).toBe(true)
  })

  test('OCR：真实幻灯片识别包含两讲的中文关键词', async () => {
    test.skip(process.env.JIWEI_OCR !== '1', '设置 JIWEI_OCR=1 下载并运行真实本地识别模型')
    test.setTimeout(1_800_000)
    await main.page.evaluate(() => window.jiwei.recognition.install())
    await expect
      .poll(() => main.page.evaluate(() => window.jiwei.recognition.status().then((s) => s.state)), {
        timeout: 1_500_000,
        intervals: [2000]
      })
      .toBe('ready')
    if (!noteId) noteId = await createNote('在线网课模型实测')
    await freshCourse('/course?ocr=1')
    await playThrough(25)
    await expect
      .poll(
        () =>
          segments().then((s) =>
            s
              .filter((x) => x.kind === 'slide')
              .map((x) => x.text)
              .join('\n')
          ),
        { timeout: 240_000, intervals: [2000] }
      )
      .toContain('间隔重复')
    await expect
      .poll(
        () =>
          segments().then((s) =>
            s
              .filter((x) => x.kind === 'slide')
              .map((x) => x.text)
              .join('\n')
          ),
        { timeout: 240_000, intervals: [2000] }
      )
      .toContain('提取练习')
    expect((await segments()).filter((s) => s.kind === 'slide').every((s) => !!s.locator.image)).toBe(true)
  })

  test('MOSS：完整真实录音精修后替换文字稿并保留说话人', async () => {
    test.skip(process.env.JIWEI_MOSS !== '1', '设置 JIWEI_MOSS=1 下载并运行真实 MOSS（约 1.2 GB）')
    test.setTimeout(2_100_000)
    await main.page.evaluate(() => window.jiwei.asr.install())
    await expect.poll(() => main.page.evaluate(() => window.jiwei.asr.status().then((s) => s.state)), { timeout: 540_000 }).toBe('ready')
    await main.page.evaluate(() => window.jiwei.moss.install())
    await expect
      .poll(() => main.page.evaluate(() => window.jiwei.moss.status().then((s) => s.state)), { timeout: 1_500_000, intervals: [2000] })
      .toBe('ready')
    if (!noteId) noteId = await createNote('在线网课模型实测')
    await freshCourse('/course-nosub?moss=1')
    await expect.poll(() => active().then((t) => t.course.transcript)).toBe('local')
    const url = (await active()).url
    await inCoursePage(main.app, url, 'document.querySelector("video").play()')
    await expect.poll(() => active().then((t) => t.course.recordingComplete), { timeout: 100_000, intervals: [1000] }).toBe(true)
    const sourceId = (await active()).sourceId!
    const recording = join(main.userData, 'course-audio', `${sourceId}.webm`)
    expect(existsSync(recording)).toBe(true)
    expect(statSync(recording).size).toBeGreaterThan(1000)
    await panel().getByRole('button', { name: '精修（区分说话人）', exact: true }).click()
    await expect
      .poll(() => segments().then((s) => s.filter((x) => x.kind === 'transcript').some((x) => typeof x.locator.speaker === 'string')), {
        timeout: 300_000,
        intervals: [2000]
      })
      .toBe(true)
    const all = await segments()
    const refined = all.filter((s) => s.kind === 'transcript')
    expect(refined.every((s) => /^S\d+$/.test(String(s.locator.speaker)) && /^［说话人 \d+］/.test(s.text))).toBe(true)
    expect(
      all
        .filter((s) => s.kind !== 'transcript')
        .map((s) => s.text)
        .join('')
    ).toContain(COURSE_BODY)
  })
})

function sourceLinks(nodes: DocNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.marks ?? []).filter((m) => m.type === 'link' && typeof m.attrs?.href === 'string').map((m) => String(m.attrs!.href)),
    ...sourceLinks(node.content ?? [])
  ])
}
function checkProposal(proposal: Proposal, sourceId: string, all: Segment[]): void {
  expect(proposal.auto).toBe(false)
  expect(proposal.status).toBe('pending')
  expect(proposal.opStatus.every((s) => s === 'pending')).toBe(true)
  const rows = proposal.ops.filter((op) => op.op === 'insert_row')
  expect(rows.length).toBeGreaterThan(0)
  const ranges = all.filter((s) => s.kind === 'transcript').map((s) => String(s.locator.value).slice(2).split(',').map(Number))
  for (const row of rows) {
    const links = sourceLinks(row.body)
    expect(links.length).toBeGreaterThan(0)
    for (const href of links) {
      const url = new URL(href)
      expect(url.protocol).toBe('jiwei:')
      expect(url.hostname).toBe('source')
      expect(url.pathname.slice(1)).toBe(sourceId)
      const t = Number(url.searchParams.get('t'))
      expect(url.searchParams.has('t')).toBe(true)
      expect(Number.isFinite(t) && t >= 0 && ranges.some(([a, b = a]) => t >= a - 5 && t <= b + 5)).toBe(true)
    }
  }
}

test.describe('真实服务商路径', () => {
  test.skip(!providers, '需要 JIWEI_IMPORT_PROVIDERS_FROM（真实服务商配置）；不使用模拟回复')
  test.describe.configure({ mode: 'serial' })
  let live: Harness
  let liveNoteId = ''
  test.beforeAll(async () => {
    live = await launch(true)
    liveNoteId = await createNote('在线网课 AI 实测', live)
    await freshCourse('/course', live)
    await expect(transcript(live)).toContainText('间隔重复')
  })
  test.afterAll(async () => {
    await live?.app.close()
  })

  test('没听懂：根据真实字幕和当前画面回答，存回当前笔记', async () => {
    test.setTimeout(180_000)
    await live.page.evaluate((id) => window.jiwei.browser.seek(id, 25, false), (await active(live)).id)
    // 跳转后播放位置要同步回积微（时间点与“没听懂”的时间范围都依赖它）
    await expect.poll(async () => Math.round((await active(live)).video?.currentTime ?? -1), { timeout: 10_000 }).toBe(25)
    await panel(live).getByRole('button', { name: '没听懂', exact: true }).click()
    await expect(answer(live)).toBeVisible()
    // 有模型时直接发送，卡片显示回答（画面随提问发送给模型，与本地视频的“没听懂”一致，不在回答区显示）
    await expect(answer(live).getByRole('button', { name: '存入笔记' })).toBeEnabled({ timeout: 150_000 })
    await expect(answer(live).locator('.chat-md')).toContainText(/间隔重复|提取练习|回忆/)
    await answer(live).getByRole('button', { name: '存入笔记' }).click()
    await expect(answer(live)).toHaveCount(0)
    await expect(
      live.page
        .locator('.cornell-row')
        .last()
        .getByRole('link', { name: /学习科学在线课.*0:/ })
    ).toBeVisible()
    await expect.poll(() => savedNote(liveNoteId, live)).toContain(`jiwei://source/${(await active(live)).sourceId}`)
  })

  test('课后整理：保留速记原话，待审提案每行带有证据支持的时间点', async () => {
    test.setTimeout(240_000)
    // 光标放到普通文字上（最后一段是“出处”链接，点击会按设计跳回视频 0:00）
    await live.page.locator('.cornell-row .cornell-body p', { hasText: '学习后用自己的话回忆。' }).click()
    await live.page.keyboard.press('ControlOrMeta+Enter')
    await live.page.keyboard.type('复习时先合上书再自测。')
    await panel(live).getByRole('button', { name: '插入时间点', exact: true }).click()
    await expect.poll(() => savedNote(liveNoteId, live)).toContain('复习时先合上书再自测。')
    await expect.poll(() => savedNote(liveNoteId, live)).toContain('?t=25')
    const before = await savedNote(liveNoteId, live)
    await panel(live).getByRole('button', { name: '课后整理', exact: true }).click()
    await expect(live.page.getByRole('button', { name: '全部接受' })).toBeVisible({ timeout: 210_000 })
    const proposals = await live.page.evaluate((id) => window.jiwei.proposals.list(id), liveNoteId)
    expect(proposals).toHaveLength(1)
    checkProposal(proposals[0], (await active(live)).sourceId!, await segments(live))
    expect(JSON.stringify(proposals[0].ops)).toContain('复习时先合上书再自测。')
    expect(await savedNote(liveNoteId, live)).toBe(before)
    await live.page.getByRole('button', { name: '全部接受' }).click()
    await expect.poll(() => live.page.evaluate((id) => window.jiwei.proposals.list(id).then((p) => p.length), liveNoteId)).toBe(0)
    await expect.poll(() => savedNote(liveNoteId, live)).not.toBe(before)
  })

  test('边看边测：真实换页触发题目，对照答案并加入复习', async () => {
    test.setTimeout(300_000)
    await freshCourse('/course?quiz=1', live)
    await expect(transcript(live)).toContainText('间隔重复')
    await panel(live).getByLabel('边看边测', { exact: true }).click()
    await expect.poll(() => active(live).then((t) => t.course.quiz)).toBe(true)
    await inCoursePage(live.app, (await active(live)).url, 'document.querySelector("video").play()')
    const quiz = live.page.getByTestId('course-quiz')
    await expect(quiz).toBeVisible({ timeout: 150_000 })
    await expect(quiz.getByRole('textbox')).toBeVisible({ timeout: 150_000 })
    await expect.poll(() => active(live).then((t) => t.video?.paused)).toBe(true)
    await quiz.getByRole('textbox').fill('在快要遗忘的时候复习，并逐渐拉长复习间隔。')
    await quiz.getByRole('button', { name: '对照答案', exact: true }).click()
    await expect(quiz).toContainText(/间隔|回忆|复习/, { timeout: 120_000 })
    await expect(quiz.getByRole('button', { name: '加入复习', exact: true })).toBeEnabled({ timeout: 120_000 })
    const before = await live.page.evaluate((id) => window.jiwei.review.forNote(id).then((r) => r.map((c) => c.id)), liveNoteId)
    await quiz.getByRole('button', { name: '加入复习', exact: true }).click()
    // 主动「加入复习」沿用存入笔记的auto提案，确认由此按钮表达并支持现有撤销。
    await expect
      .poll(() => live.page.evaluate((id) => window.jiwei.review.forNote(id).then((r) => r.filter((c) => !c.suspended).length), liveNoteId))
      .toBeGreaterThan(before.length)
    await expect.poll(() => active(live).then((t) => t.video?.paused)).toBe(false)
  })
})
