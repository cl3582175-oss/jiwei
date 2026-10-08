import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { makePdf } from './fixtures/makePdf'

// 阅读辅助（真实模型）：选中资料文字 → 浮条 → 就地答复 → 追问 → 存入笔记 → 原文标记；工作区 AI 面板。
const source = process.env.JIWEI_IMPORT_PROVIDERS_FROM
test.skip(!source, '需要 JIWEI_IMPORT_PROVIDERS_FROM（真实服务商配置）')
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
const shots = process.env.SHOTS_DIR
const shot = async (name: string): Promise<void> => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) })
}

test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-assist-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

/** 在资料正文中选中一段文字，并像用户松开鼠标一样触发浮条 */
async function selectText(text: string): Promise<void> {
  await page.evaluate((t) => {
    const el = [...document.querySelectorAll('.source-text [data-segment]')].find((e) => e.textContent?.includes(t))!
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let n: Node | null
    while ((n = walker.nextNode())) {
      const i = n.textContent!.indexOf(t)
      if (i >= 0) {
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + t.length)
        const s = getSelection()!
        s.removeAllRanges()
        s.addRange(r)
        break
      }
    }
    el.closest('article')!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  }, text)
}

const card = () => page.getByRole('dialog', { name: '就地答复' })

test('setup: source in the workspace', async () => {
  test.setTimeout(120_000)
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-assist-src-'))
  writeFileSync(
    join(dir, '学习科学.md'),
    '# 学习科学的关键方法\n\n## 交错练习\n\n把不同类型的题目混在一起练习，而不是一种题做完再做下一种。交错练习短期内感觉更难，但长期迁移效果更好，这是一种合意困难。\n\n## 提取练习\n\n主动回忆比反复阅读更有效，这被称为测试效应。\n'
  )
  await page.evaluate((p) => window.jiwei.sources.importPaths([p]), join(dir, '学习科学.md'))
  await page.getByRole('button', { name: /资料库/ }).click()
  await page.getByText('学习科学', { exact: true }).dblclick()
  await expect(page.locator('.source-text p').first()).toContainText('合意困难', { timeout: 15_000 })
})

test('select → explain: answer card in place, follow-up', async () => {
  test.setTimeout(150_000)
  await selectText('合意困难')
  const bar = page.getByRole('toolbar', { name: '选区操作' })
  await expect(bar).toBeVisible()
  await expect(bar.getByRole('button')).toHaveText(['解释', '讲明白', '翻译', '问 AI'])
  await shot('81-selection-toolbar')
  await bar.getByRole('button', { name: '解释' }).click()
  await expect(card()).toBeVisible()
  await expect(card()).toContainText('“合意困难”是什么意思？')
  // 按技能结构作答，并结合语境（交错练习）
  await expect(card().locator('.chat-md')).toContainText('一句话', { timeout: 90_000 })
  await expect(card().getByRole('button', { name: '存入笔记' })).toBeEnabled({ timeout: 90_000 })
  await expect(card().locator('.chat-md')).toContainText(/交错/)
  await shot('82-answer-card')

  // 追问
  await card().getByRole('textbox', { name: '追问…' }).fill('能再举一个生活中的例子吗？一句话就行')
  await page.keyboard.press('Enter')
  await expect(card().locator('.chat-md')).toHaveCount(2, { timeout: 90_000 })
  await expect(card().getByRole('button', { name: '存入笔记' })).toBeEnabled({ timeout: 90_000 })
})

test('save to note: new note beside the source, with a source link', async () => {
  test.setTimeout(60_000)
  await card().getByRole('button', { name: '存入笔记' }).click()
  await expect(card()).toHaveCount(0)
  // 新建笔记打开在资料右侧，内容直接写入（无需确认）
  await expect(page.getByPlaceholder('笔记标题')).toHaveValue('《学习科学》学习笔记', { timeout: 10_000 })
  await expect(page.locator('.source-text')).toBeVisible()
  const row = page.locator('.cornell-row').last()
  await expect(row).toContainText('“合意困难”是什么意思？', { timeout: 10_000 })
  await expect(row.getByRole('link', { name: '《学习科学》' })).toBeVisible()
  await expect(page.getByRole('button', { name: '全部接受' })).toHaveCount(0)
  await shot('83-saved-to-note')

  // 原文边缘留下标记，点开回到当时的对话
  const dot = page.locator('.thread-dot').first()
  await expect(dot).toBeVisible()
  await dot.click()
  await expect(card()).toBeVisible()
  await expect(card().locator('.chat-md').first()).toContainText('一句话')
  await page.keyboard.press('Escape')
  await expect(card()).toHaveCount(0)
})

test('source link in the note jumps back to the passage', async () => {
  await page.locator('.source-text').evaluate((el) => el.closest('.overflow-auto')!.scrollTo(0, 9999))
  await page.locator('.cornell-row').last().getByRole('link', { name: '《学习科学》' }).click()
  await expect(page.locator('.source-text .is-flash')).toContainText('合意困难')
})

test('workspace AI panel: sees both sides, pins as a column', async () => {
  test.setTimeout(180_000)
  await page.getByRole('button', { name: 'AI 助手' }).click()
  const panel = page.getByRole('complementary', { name: 'AI 助手' })
  await expect(panel).toBeVisible()
  // 上下文标签：当前笔记与资料
  await expect(panel.getByText('《学习科学》学习笔记')).toBeVisible()
  await expect(panel.getByText('学习科学', { exact: true })).toBeVisible()
  await shot('84-ai-panel')
  await panel.getByRole('button', { name: '帮这篇笔记写个总结' }).click()
  await expect(panel.getByText('提案：补充总结')).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('button', { name: '全部接受' })).toBeVisible({ timeout: 10_000 })
  // 钉住：成为右侧栏
  await panel.getByRole('button', { name: '钉在右侧' }).click()
  await expect(page.getByTestId('assist').getByRole('complementary', { name: 'AI 助手' })).toBeVisible()
  // 钉住后右下角不再有浮动按钮，第 2 栏自动收起
  await expect(page.getByRole('button', { name: 'AI 助手' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /展开侧栏/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '取消钉住' })).toBeVisible()
  await shot('85-ai-panel-pinned')
})

test('PDF: pdf.js viewer, select text → translate, region → ask', async () => {
  test.setTimeout(240_000)
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-assist-pdf-'))
  const file = join(dir, 'Learning Science.pdf')
  writeFileSync(
    file,
    makePdf([
      ['Learning Science, Chapter 1', 'Spaced repetition beats cramming.', 'Interleaving creates a desirable difficulty.'],
      ['Chapter 2: Retrieval practice', 'Testing yourself strengthens memory more than rereading.']
    ])
  )
  await page.evaluate((p) => window.jiwei.sources.importPaths([p]), file)
  // 资料由接口导入，刷新界面列表
  await page.reload()
  await page.waitForSelector('nav')
  await page.getByRole('button', { name: /资料库/ }).click()
  await page.getByText('Learning Science', { exact: true }).dblclick()
  const viewer = page.getByTestId('pdf-viewer')
  await expect(viewer.locator('.textLayer').first()).toContainText('desirable difficulty', { timeout: 20_000 })
  await expect(page.getByText('1 / 2')).toBeVisible()

  // 选中文字层中的文字 → 浮条 → 翻译
  await page.evaluate(() => {
    const span = [...document.querySelectorAll('.textLayer span')].find((s) => s.textContent?.includes('desirable difficulty'))!
    const n = span.firstChild!
    const i = n.textContent!.indexOf('desirable difficulty')
    const r = document.createRange()
    r.setStart(n, i)
    r.setEnd(n, i + 'desirable difficulty'.length)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(r)
    span.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.getByRole('toolbar', { name: '选区操作' }).getByRole('button', { name: '翻译' }).click()
  await expect(card().locator('.chat-md')).toContainText(/合意|困难/, { timeout: 90_000 })
  await expect(card().getByRole('button', { name: '存入笔记' })).toBeEnabled({ timeout: 90_000 })
  await card().getByRole('button', { name: '存入笔记' }).click()
  await expect(
    page
      .locator('.cornell-row')
      .last()
      .getByRole('link', { name: /Learning Science.*第 1 页/ })
  ).toBeVisible({ timeout: 10_000 })
  // 页面边缘出现标记
  await expect(viewer.locator('.pdf-thread-dot')).toHaveCount(1)
  await shot('86-pdf-translate')

  // 框选图形区域 → 就地提问（当前模型不能看图时，依据区域文字回答并提示）
  await page.getByRole('button', { name: '框选提问' }).click()
  const box = (await viewer.locator('.page[data-page-number="1"] canvas').boundingBox())!
  // 方块位于页面 (60,320)-(280,460)，页面高 792
  const sx = box.width / 612
  const sy = box.height / 792
  const x0 = box.x + 50 * sx
  const y0 = box.y + (792 - 470) * sy
  await page.mouse.move(x0, y0)
  await page.mouse.down()
  await page.mouse.move(x0 + 240 * sx, y0 + 160 * sy, { steps: 6 })
  await page.mouse.up()
  await expect(card()).toBeVisible()
  await expect(card().getByRole('img', { name: '框选提问' })).toBeVisible()
  await shot('87-pdf-region')
  await card().getByRole('button', { name: '解释这部分' }).click()
  await expect(card().getByRole('button', { name: '存入笔记' })).toBeEnabled({ timeout: 120_000 })
  await expect(card().locator('.chat-md')).toContainText(/retention|保持|记忆|图/)
  await page.keyboard.press('Escape')
})

test('video: "didn\'t get it" explains the last 30 s, saves a time link; ask about a frame', async () => {
  test.skip(process.platform !== 'darwin', '需要 macOS 语音合成')
  test.setTimeout(600_000)
  const dir = mkdtempSync(join(tmpdir(), 'jiwei-assist-video-'))
  const aiff = join(dir, 'v.aiff')
  execFileSync('say', [
    '-v',
    'Tingting',
    '-o',
    aiff,
    '交错练习就是把不同类型的题目混在一起练。它短期内更难，但长期效果更好，这叫合意困难。'
  ])
  // 用转写引擎自带的 ffmpeg 合成一段带画面的视频（引擎未安装时先安装）
  await page.evaluate(() => window.jiwei.asr.install())
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.asr.status())).state, { timeout: 480_000 }).toBe('ready')
  const ffmpeg = join(process.env.HOME!, 'Library/Application Support/jiwei-models/ffmpeg/ffmpeg')
  const mp4 = join(dir, '交错练习讲解.mp4')
  execFileSync(ffmpeg, [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=640x360:rate=10',
    '-i',
    aiff,
    '-shortest',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    mp4
  ])
  await page.evaluate((p) => window.jiwei.sources.importPaths([p]), mp4)
  await page.reload()
  await page.waitForSelector('nav')
  await page.getByRole('button', { name: /资料库/ }).click()
  await page.getByText('交错练习讲解', { exact: true }).dblclick()
  const transcript = page.getByRole('article', { name: '转写稿' })
  await expect(transcript).toContainText('交错练习', { timeout: 120_000 })

  // 播放到中段 → 没听懂
  await page.getByTestId('media').evaluate((m: HTMLMediaElement) => {
    m.currentTime = Math.min(6, m.duration - 0.5)
  })
  await page.getByRole('button', { name: '没听懂' }).click()
  await expect(card()).toContainText('这段没看懂')
  await expect(card().getByRole('button', { name: '存入笔记' })).toBeEnabled({ timeout: 120_000 })
  await expect(card().locator('.chat-md')).toContainText(/交错|难/)
  await shot('88-video-not-get-it')
  await card().getByRole('button', { name: '存入笔记' }).click()
  await expect(
    page
      .locator('.cornell-row')
      .last()
      .getByRole('link', { name: /交错练习讲解.*0:0\d/ })
  ).toBeVisible({ timeout: 10_000 })
  // 时间轴上留下标记
  await expect(page.getByRole('button', { name: /就地提问/ }).first()).toBeVisible()

  // 问这个画面
  await page.getByRole('button', { name: '问这个画面' }).click()
  await expect(card().getByRole('img', { name: '框选提问' })).toBeVisible()
  await card().getByRole('textbox').fill('画面里有什么？和讲解有什么关系？')
  await page.keyboard.press('Enter')
  await expect(card().getByRole('button', { name: '存入笔记' })).toBeEnabled({ timeout: 120_000 })
  await shot('89-video-frame')
  await page.keyboard.press('Escape')
})

test('note revision: select → AI 精简 → inline diff → accept; AI edits a mind map', async () => {
  test.setTimeout(300_000)
  await page.reload()
  await page.waitForSelector('nav')
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('修订实测')
  await page.keyboard.press('Enter')
  const long =
    '间隔重复其实就是一种非常非常有用的、被很多很多人广泛使用的记忆方法，它的核心思想说到底就是要在我们快要忘记某个知识点的那个时候再去进行一次复习，这样记忆就会保持得更久更牢固。'
  await page.keyboard.type(long)
  await expect.poll(() => page.evaluate(() => window.jiwei.notes.list({ search: '修订实测' }).then((n) => n.length))).toBeGreaterThan(0)
  await page.locator('.cornell-doc p', { hasText: '间隔重复其实' }).click({ clickCount: 3 })
  await page.getByRole('button', { name: 'AI 修改' }).click()
  await page.getByRole('menuitem', { name: '精简' }).click()
  const diff = page.getByRole('group', { name: /AI 建议/ })
  await expect(diff).toBeVisible({ timeout: 150_000 })
  await expect(diff.locator('del').first()).toBeVisible()
  await shot('96-live-inline-diff')
  await page.keyboard.press('Escape')
  await diff.getByRole('button', { name: '接受' }).click()
  await expect(diff).toHaveCount(0)
  const after = await page.locator('.cornell-doc p', { hasText: '间隔重复' }).first().textContent()
  expect(after!.length).toBeLessThan(long.length)

  // AI 修改导图
  const noteId = await page.evaluate(() => window.jiwei.notes.list({ search: '修订实测' }).then((n) => n[0].id))
  await page.evaluate(
    (noteId) =>
      window.jiwei.proposals.create({
        noteId,
        title: '导图',
        ops: [{ op: 'insert_row', afterRowId: null, cue: [], body: [{ type: 'embed', attrs: { id: 'mm', kind: 'mindmap' } }] }],
        embeds: {
          mm: {
            kind: 'mindmap',
            data: {
              root: 'r',
              nodes: {
                r: { text: '学习方法', parent: null, order: 0 },
                a: { text: '间隔重复', parent: 'r', order: 0 },
                b: { text: '提取练习', parent: 'r', order: 1 }
              }
            }
          }
        }
      }),
    noteId
  )
  await page.getByRole('button', { name: '全部接受' }).click()
  const block = page.locator('.embed-block[data-kind="mindmap"]')
  await block.hover()
  await block.getByRole('button', { name: 'AI 修改导图' }).click()
  await page.getByRole('dialog', { name: '就地答复' }).getByRole('textbox').fill('增加一个分支“交错练习”，下面写两个要点')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '全部接受' })).toBeVisible({ timeout: 150_000 })
  await shot('97-live-mindmap-proposal')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '全部接受' }).click()
  await expect(page.locator('.embed-block[data-kind="mindmap"] svg.mindmap-svg')).toContainText('交错练习')
})
