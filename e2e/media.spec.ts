import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { navTo } from './fixtures/nav'

// 视频 / 音频的文字层：同名字幕直接使用；没有字幕时本地转写（sherpa-onnx + SenseVoice，首次下载引擎）。
// 测试音频用 macOS 系统语音合成，因此只在 macOS 上运行。
test.skip(process.platform !== 'darwin', '需要 macOS 语音合成生成测试音频')
test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page
let dir = ''
const shots = process.env.SHOTS_DIR
const SPEECH = '大家好，今天我们讲间隔重复。学习后一天，大约会遗忘百分之六十六。所以要在快要遗忘的时候复习。'

function makeAudio(name: string): string {
  const aiff = join(dir, `${name}.aiff`)
  const m4a = join(dir, `${name}.m4a`)
  // 按内容哈希去重是产品行为。不同测试资料必须有不同音频内容。
  execFileSync('say', ['-v', 'Tingting', '-o', aiff, `${SPEECH}这是${name}。`])
  execFileSync('afconvert', ['-f', 'm4af', '-d', 'aac', aiff, m4a])
  return m4a
}

const openSource = async (title: string): Promise<void> => {
  await page.reload()
  await page.waitForSelector('nav')
  await navTo(page, /资料库/)
  await page.getByText(title, { exact: true }).dblclick()
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jiwei-media-'))
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-e2e-media-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

test('sidecar subtitles become the transcript', async () => {
  const m4a = makeAudio('带字幕的讲解')
  writeFileSync(
    m4a.replace(/\.m4a$/, '.srt'),
    '1\n00:00:00,000 --> 00:00:03,000\n大家好，今天我们讲间隔重复。\n\n2\n00:00:03,200 --> 00:00:07,000\n学习后一天，大约会遗忘66%。\n'
  )
  await page.evaluate((p) => window.jiwei.sources.importPaths([p]), m4a)
  await openSource('带字幕的讲解')
  const transcript = page.getByRole('article', { name: '转写稿' })
  await expect(transcript).toContainText('大家好，今天我们讲间隔重复。学习后一天，大约会遗忘66%。')
  await expect(transcript.getByRole('button', { name: '0:00' })).toBeVisible()
  // 转写稿进入知识库（带时间位置）
  const hits = await page.evaluate(() => window.jiwei.segments.search('间隔重复'))
  expect(hits.some((h) => String(h.locator.value).startsWith('t='))).toBe(true)
})

test('local transcription: download engine on demand, transcribe, synced transcript', async () => {
  test.setTimeout(600_000)
  const m4a = makeAudio('间隔重复讲解')
  // 引擎安装在所有知识库共享的模型目录：已安装时导入即自动转写，否则走“生成转写稿”（首次下载）
  const installed = (await page.evaluate(() => window.jiwei.asr.status())).state === 'ready'
  await page.evaluate((p) => window.jiwei.sources.importPaths([p]), m4a)
  await openSource('间隔重复讲解')
  if (!installed) {
    await expect(page.getByText('还没有转写稿')).toBeVisible()
    if (shots) await page.screenshot({ path: join(shots, '91-media-empty.png') })
    await page.getByRole('button', { name: '生成转写稿' }).click()
  }
  const transcript = page.getByRole('article', { name: '转写稿' })
  await expect(transcript).toContainText('间隔重复', { timeout: 540_000 })
  await expect(transcript).toContainText(/66%|六十六/)
  expect((await page.evaluate(() => window.jiwei.asr.status())).state).toBe('ready')

  // 点时间跳转；播放位置同步到工作区上下文
  await transcript.getByRole('button', { name: '0:00' }).click()
  await expect(transcript.locator('.transcript-line.is-current')).toHaveCount(1, { timeout: 10_000 })
  await page.getByTestId('media').evaluate((m: HTMLMediaElement) => m.pause())
  if (shots) await page.screenshot({ path: join(shots, '92-media-transcript.png') })

  // 选中转写稿文字 → 浮条（锚点带时间段）
  await page.evaluate(() => {
    const p = document.querySelector('.transcript-line')!
    const n = [...p.childNodes].find((x) => x.nodeType === Node.TEXT_NODE && x.textContent!.includes('间隔重复'))!
    const i = n.textContent!.indexOf('间隔重复')
    const r = document.createRange()
    r.setStart(n, i)
    r.setEnd(n, i + 4)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(r)
    p.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await expect(page.getByRole('toolbar', { name: '选区操作' })).toBeVisible()
})

test('fix a transcription error in place', async () => {
  const line = page.locator('.transcript-line').first()
  await line.hover()
  await line.getByRole('button', { name: '修改这一句（纠正转写错误）' }).click()
  const box = page.getByRole('textbox', { name: '修改这一句（纠正转写错误）' })
  await box.fill('大家好，今天我们讲间隔重复与合意困难。')
  await page.keyboard.press('Enter')
  await expect(line).toContainText('合意困难')
  // 修改后进入知识库检索
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.segments.search('合意困难'))).length).toBeGreaterThan(0)
})

test('later imports are transcribed automatically once the engine is installed', async () => {
  test.setTimeout(120_000)
  const m4a = makeAudio('自动转写')
  const r = await page.evaluate((p) => window.jiwei.sources.importPaths([p]), m4a)
  const id = r.imported[0]?.id ?? (await page.evaluate(() => window.jiwei.sources.list({ search: '自动转写' })))[0].id
  await expect
    .poll(async () => (await page.evaluate((sid) => window.jiwei.segments.list(sid), id)).map((x) => x.text).join(''), { timeout: 90_000 })
    .toContain('遗忘')
})

test('cloud transcription (OpenAI-compatible endpoint, mocked locally)', async () => {
  test.setTimeout(120_000)
  const { createServer } = await import('http')
  const seen: { model: boolean; file: boolean } = { model: false, file: false }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1')
      seen.model = body.includes('name="model"') && body.includes('whisper-1')
      seen.file = body.includes('filename="part000.mp3"')
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          text: 'x',
          segments: [
            { start: 0, end: 2, text: ' 云端转写第一句。' },
            { start: 2.2, end: 4, text: '云端转写第二句。' }
          ]
        })
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  try {
    const p = await page.evaluate(
      (url) => window.jiwei.providers.save({ kind: 'custom', name: 'Mock ASR', baseUrl: url }),
      `http://127.0.0.1:${port}/v1`
    )
    const s = await page.evaluate(() => window.jiwei.settings.get())
    await page.evaluate(
      ([ai, id]) => window.jiwei.settings.set({ ai: { ...ai, transcription: { mode: 'cloud', providerId: id, model: 'whisper-1' } } }),
      [s.ai, p.id] as const
    )
    const r = await page.evaluate((f) => window.jiwei.sources.importPaths([f]), makeAudio('云端转写'))
    const id = r.imported[0].id
    await expect
      .poll(async () => (await page.evaluate((sid) => window.jiwei.segments.list(sid), id)).map((x) => x.text).join(''), {
        timeout: 90_000
      })
      .toBe('云端转写第一句。云端转写第二句。')
    expect(seen).toEqual({ model: true, file: true })
  } finally {
    server.close()
    const s = await page.evaluate(() => window.jiwei.settings.get())
    await page.evaluate(
      (ai) => window.jiwei.settings.set({ ai: { ...ai, transcription: { mode: 'local', providerId: null, model: null } } }),
      s.ai
    )
  }
})
