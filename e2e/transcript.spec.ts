import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join, resolve } from 'path'

// 离线分段只测试产品交互与持久化；真实模型另在条件用例运行。
test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page
const sourceId = randomUUID(),
  exportDir = mkdtempSync(join(tmpdir(), 'jiwei-transcript-export-'))
const modelRoot = mkdtempSync(join(tmpdir(), 'jiwei-transcript-models-'))
const models = join(modelRoot, 'jiwei-models')
mkdirSync(models)
symlinkSync(join(homedir(), 'Library/Application Support/jiwei-models/ffmpeg'), join(models, 'ffmpeg'), 'dir')
const audio = join(exportDir, 'mix.webm')
execFileSync(join(models, 'ffmpeg/ffmpeg'), [
  '-nostdin',
  '-v',
  'error',
  '-i',
  resolve('e2e/fixtures/meeting.wav'),
  '-c:a',
  'libopus',
  '-y',
  audio
])
test.beforeAll(async () => {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-transcript-'))}`],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '' }
  })
  page = await app.firstWindow()
  await app.evaluate(({ app }, root) => app.setPath('appData', root), modelRoot)
  await page.waitForSelector('nav')
  const size = process.env.JIWEI_TEST_WINDOW?.split('x').map(Number)
  if (size?.length === 2) await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), size)
  await app.evaluate(
    ({ app }, { sourceId, audio }) => {
      const path = process.getBuiltinModule('path'),
        fs = process.getBuiltinModule('fs')
      const req = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json'))
      const Database = req('better-sqlite3') as typeof import('better-sqlite3')
      const db = new Database(path.join(app.getPath('userData'), 'data/jiwei.db')),
        personal = new Database(path.join(app.getPath('userData'), 'profile/memory.db')),
        now = Date.now()
      const folder = path.join(app.getPath('userData'), 'recordings', sourceId)
      fs.mkdirSync(folder, { recursive: true })
      fs.copyFileSync(audio, path.join(folder, 'mix.webm'))
      try {
        db.prepare('INSERT INTO sources (id,title,kind,accessed_at,created_at,updated_at,updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          sourceId,
          '三人会议转写交互',
          'recording',
          now,
          now,
          now,
          'e2e'
        )
        db.prepare(
          'INSERT INTO recordings (id,source_id,scene,status,tracks,started_at,duration_ms,markers,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
        ).run(
          sourceId,
          sourceId,
          'meeting',
          'ready',
          '["mic"]',
          now,
          45000,
          '[{"t":12,"kind":"decision","text":"核对决定"}]',
          now,
          now,
          'e2e'
        )
        const lines = [
          ['S01', 0, 7, '积威使用 FSRS 安排复习。'],
          ['S02', 8, 15, '学习后一天回忆关键概念。'],
          ['S01', 16, 23, '间隔重复需要保留原声。'],
          ['S03', 24, 32, '下次会议确认任务。']
        ] as const
        for (const [i, [label, start, end, text]] of lines.entries())
          db.prepare(
            'INSERT INTO source_segments (id,source_id,ordinal,kind,locator,text,hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)'
          ).run(
            `voice-${i}`,
            sourceId,
            i,
            'transcript',
            JSON.stringify({ type: 'FragmentSelector', value: `t=${start},${end}`, speaker: label, track: 'mic' }),
            `［说话人 ${Number(label.slice(1))}］${text}`,
            `voice-${i}`,
            now,
            now
          )
        for (const label of ['S01', 'S02', 'S03'])
          personal
            .prepare('INSERT INTO recording_speakers (source_id,label,centroid) VALUES (?,?,?)')
            .run(
              sourceId,
              label,
              Buffer.from(new Float32Array(label === 'S01' ? [1, 0, 0] : label === 'S02' ? [0, 1, 0] : [0, 0, 1]).buffer)
            )
      } finally {
        db.close()
        personal.close()
      }
    },
    { sourceId, audio }
  )
  await page.reload()
  await page.waitForSelector('nav')
  await page.getByRole('button', { name: /资料库/ }).click()
  await page.getByText('三人会议转写交互', { exact: true }).dblclick()
  await expect(page.getByTestId('dialogue-transcript')).toBeVisible()
})
test.afterAll(async () => {
  await app?.close()
})
const screenshot = async (name: string): Promise<void> => {
  if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, name) })
}
const card = (n: number) => page.getByTestId('speaker-card').filter({ hasText: `说话人 ${n} 是谁` })
async function setTheme(theme: 'light' | 'dark'): Promise<void> {
  await page.getByRole('button', { name: /^设置/ }).click()
  const settings = page.getByRole('dialog')
  await settings.getByRole('button', { name: '外观', exact: true }).click()
  await settings.getByRole('button', { name: theme === 'dark' ? '深色' : '浅色', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme)
  await expect.poll(() => page.evaluate(() => window.jiwei.settings.get().then((s) => s.theme))).toBe(theme)
  await page.keyboard.press('Escape')
  await expect(settings).not.toBeVisible()
}

async function transcriptContrast() {
  return page.locator('.speaker-name, .transcript-time').evaluateAll((elements) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d')!
    const luminance = (rgb: number[]) =>
      rgb.reduce((sum, byte, i) => {
        const channel = byte / 255
        return sum + (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]
      }, 0)
    return elements.map((element) => {
      const ancestors: Element[] = []
      for (let parent: Element | null = element; parent; parent = parent.parentElement) ancestors.unshift(parent)
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg')
      ctx.fillRect(0, 0, 1, 1)
      for (const ancestor of ancestors) {
        ctx.fillStyle = getComputedStyle(ancestor).backgroundColor
        ctx.fillRect(0, 0, 1, 1)
      }
      const background = Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3)
      const color = getComputedStyle(element).color
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 1, 1)
      const foreground = Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3)
      const a = luminance(background),
        b = luminance(foreground)
      return { text: element.textContent, color, background, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
    })
  })
}

async function screenshotTranscript(theme: 'light' | 'dark'): Promise<void> {
  await setTheme(theme)
  const duringTransition = await transcriptContrast()
  await expect
    .poll(() =>
      page
        .getByTestId('dialogue-transcript')
        .locator('button')
        .evaluateAll(
          (buttons) => buttons.flatMap((button) => button.getAnimations()).filter((animation) => animation.playState === 'running').length
        )
    )
    .toBe(0)
  const settled = await transcriptContrast()
  expect(settled.length).toBeGreaterThan(0)
  expect(Math.min(...settled.map((line) => line.contrast))).toBeGreaterThanOrEqual(4.5)
  if (process.env.SHOTS_DIR)
    writeFileSync(
      join(process.env.SHOTS_DIR, `transcript-${theme}-colors.json`),
      JSON.stringify({ theme, duringTransition, settled }, null, 2)
    )
  await screenshot(`transcript-${theme}.png`)
}

test('确认卡片、新建人与这是我登记声纹，窄窗完整显示', async () => {
  await expect(page.getByTestId('speaker-card')).toHaveCount(3)
  for (const id of ['transcript-tools', 'speaker-card'])
    expect(
      await page
        .getByTestId(id)
        .first()
        .evaluate((e) => e.scrollWidth <= e.clientWidth)
    ).toBe(true)
  await screenshot('speaker-cards.png')
  await card(1).getByRole('button', { name: '确认说话人' }).click()
  const choice = page.getByTestId('speaker-choices')
  await choice.getByRole('textbox', { name: '新建人员姓名' }).fill('王老师')
  await choice.getByRole('button', { name: '添加', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.jiwei.people.list().then((p) => p.find((x) => x.name === '王老师')?.voiceprints)))
    .toBe(1)
  await card(2).getByRole('button', { name: '这是我', exact: true }).click()
  await card(3).getByRole('button', { name: '跳过', exact: true }).click()
  await expect(page.getByTestId('speaker-card')).toHaveCount(0)
  await expect(page.locator('[data-segment="voice-0"]')).toContainText('积威')
  expect((await page.evaluate(() => window.jiwei.people.list())).find((p) => p.isMe)?.voiceprints).toBe(1)
})
test('播放时间、只改一句不登记声纹，改全部重新确认', async () => {
  await expect.poll(() => page.getByTestId('media').evaluate((m: HTMLMediaElement) => m.duration)).toBeGreaterThan(44)
  await expect
    .poll(() => page.getByTestId('media').evaluate((m: HTMLMediaElement) => (m.seekable.length ? m.seekable.end(0) : 0)))
    .toBeGreaterThan(16)
  await page.locator('.dialogue-line').nth(2).getByRole('button', { name: '0:16', exact: true }).click()
  await expect.poll(() => page.getByTestId('media').evaluate((m: HTMLMediaElement) => m.currentTime)).toBeGreaterThanOrEqual(16)
  await page.getByTestId('media').evaluate((m: HTMLMediaElement) => m.pause())
  await page.locator('.dialogue-line').first().getByRole('button', { name: '更改说话人：王老师' }).click()
  await page.getByTestId('speaker-choices').getByRole('button', { name: '这是我', exact: true }).click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.segments.list(id).then((s) => s[0].text), sourceId)).toMatch(/^［我］/)
  expect((await page.evaluate(() => window.jiwei.people.list())).find((p) => p.isMe)?.voiceprints).toBe(1)
  expect((await page.evaluate((id) => window.jiwei.segments.list(id), sourceId))[0].locator.edited).toBe(true)
  await expect(page.evaluate((id) => window.jiwei.moss.refine(id), sourceId)).rejects.toThrow(/覆盖|overwrite/)
  await expect(page.evaluate((id) => window.jiwei.asr.transcribe(id), sourceId)).rejects.toThrow(/覆盖|overwrite/)
  await page.locator('.dialogue-line').nth(2).getByRole('button', { name: '更改说话人：王老师' }).click()
  await page.getByTestId('speaker-choices').getByRole('button', { name: '此说话人的全部', exact: true }).click()
  await page.getByTestId('speaker-choices').getByRole('button', { name: '这是我', exact: true }).click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.segments.list(id).then((s) => s[2].text), sourceId)).toMatch(/^［我］/)
  expect((await page.evaluate(() => window.jiwei.people.list())).find((p) => p.isMe)?.voiceprints).toBe(2)
})
test('纠错、搜索、导出和改名后的 CSS 批注锚点', async () => {
  const body = page.locator('[data-segment="voice-0"]')
  await body.dblclick()
  const edit = page.getByRole('textbox', { name: '修改这一句（纠正转写错误）' })
  await edit.fill('积微使用 FSRS 安排复习。')
  await edit.press('Enter')
  await expect(body).toContainText('积微')
  await expect
    .poll(() => page.evaluate(() => window.jiwei.people.corrections().then((c) => c.map((x) => `${x.from}→${x.to}`))))
    .toContain('积威→积微')
  await expect.poll(() => page.evaluate(() => window.jiwei.segments.search('积微').then((s) => s.length))).toBeGreaterThan(0)
  await page.getByRole('textbox', { name: '搜索转写稿' }).fill('间隔重复')
  await expect(page.locator('.transcript-body mark')).toHaveText('间隔重复')
  await page.getByRole('button', { name: '下一个', exact: true }).click()
  await page.getByRole('textbox', { name: '搜索转写稿' }).fill('')
  await body.evaluate((el) => {
    const n = el.firstChild!,
      r = document.createRange()
    r.setStart(n, 0)
    r.setEnd(n, 2)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(r)
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.getByRole('toolbar', { name: '选区操作' }).getByRole('button', { name: '高亮', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => [...(CSS.highlights.get('jw-yellow') ?? [])].map((r) => (r as Range).toString())))
    .toEqual(['积微'])
  const me = (await page.evaluate(() => window.jiwei.people.list())).find((p) => p.isMe)!
  await page.evaluate((p) => window.jiwei.people.save({ ...p, name: '我的较长名字' }, p.id), me)
  await expect
    .poll(() => page.evaluate(() => [...(CSS.highlights.get('jw-yellow') ?? [])].map((r) => (r as Range).toString())))
    .toEqual(['积微'])
  const annotation = (await page.evaluate((id) => window.jiwei.annotations.list('source', id), sourceId))[0]
  expect(annotation.selector.ownerId).toBe('voice-0')
  expect(annotation.selector.quote).toBe('积微')
  for (const format of ['md', 'srt'] as const) {
    const file = join(exportDir, `transcript.${format}`)
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    }, file)
    await page.getByRole('button', { name: '导出转写稿', exact: true }).click()
    await page.getByRole('menuitem', { name: format === 'md' ? 'Markdown' : 'SRT 字幕' }).click()
    await expect
      .poll(() => {
        try {
          return readFileSync(file, 'utf8')
        } catch {
          return ''
        }
      })
      .toContain('积微使用 FSRS')
    expect(readFileSync(file, 'utf8')).toContain('我的较长名字')
  }
  await screenshotTranscript('light')
  await screenshotTranscript('dark')
  await setTheme('light')
})
test('仅本地不进入 AI 检索、保留本地 FTS，删除音频留稿，清声纹包含 centroid', async () => {
  await page.getByRole('checkbox', { name: '仅本地', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: '仅本地', exact: true })).toBeChecked()
  await expect.poll(() => page.evaluate((id) => window.jiwei.sources.get(id).then((s) => s?.aiExcluded), sourceId)).toBe(true)
  expect((await page.evaluate(() => window.jiwei.knowledge.search('积微', { type: 'all' }, 10))).some((h) => h.parentId === sourceId)).toBe(
    false
  )
  expect((await page.evaluate(() => window.jiwei.segments.search('积微'))).some((s) => s.sourceId === sourceId)).toBe(true)
  await expect(
    page.evaluate(
      (id) =>
        window.jiwei.chat.send({
          conversationId: null,
          text: '解释积微使用 FSRS',
          providerId: 'no-provider',
          model: 'no-model',
          effort: 'off',
          scope: { type: 'all' },
          context: { targets: [{ kind: 'source-text', parentType: 'source', parentId: id, quote: '积微使用 FSRS' }], sourceId: id }
        }),
      sourceId
    )
  ).rejects.toThrow(/仅本地/)
  await page.evaluate((id) => window.jiwei.recording.deleteAudio(id), sourceId)
  await expect(page.getByTestId('dialogue-transcript')).toBeVisible()
  await expect(page.getByTestId('media')).toHaveCount(0)
  // 本文件只挂 ffmpeg，未安装 MOSS；按钮走 SenseVoice 完整转写入口。
  await expect(page.getByTestId('transcript-tools').getByRole('button', { name: '生成转写稿' })).toBeDisabled()
  await expect(page.locator('.transcript-time').first()).toBeDisabled()
  await page.evaluate(() => window.jiwei.people.clear(false))
  expect((await page.evaluate(() => window.jiwei.people.list())).every((p) => p.voiceprints === 0)).toBe(true)
  expect((await page.evaluate((id) => window.jiwei.recording.speakers(id), sourceId)).every((s) => !s.hasCentroid)).toBe(true)
})
