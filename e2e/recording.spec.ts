import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, symlinkSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join, resolve } from 'path'

test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page
const userData = mkdtempSync(join(tmpdir(), 'jiwei-recording-'))
const exportDir = mkdtempSync(join(tmpdir(), 'jiwei-recording-export-'))
const modelRoot = mkdtempSync(join(tmpdir(), 'jiwei-recording-models-')),
  models = join(modelRoot, 'jiwei-models')
mkdirSync(models)
symlinkSync(join(homedir(), 'Library/Application Support/jiwei-models/ffmpeg'), join(models, 'ffmpeg'), 'dir')
async function launch(): Promise<void> {
  app = await electron.launch({
    args: [
      '.',
      `--user-data-dir=${userData}`,
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${resolve('e2e/fixtures/meeting.wav')}`
    ],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: '', JIWEI_EXPORT_DIR: exportDir }
  })
  page = await app.firstWindow()
  await app.evaluate(({ app }, root) => app.setPath('appData', root), modelRoot)
  await page.waitForSelector('nav')
  const size = process.env.JIWEI_TEST_WINDOW?.split('x').map(Number)
  if (size?.length === 2) await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), size)
}
test.beforeAll(launch)
test.afterAll(async () => {
  await app?.close()
})
test('录音入口在窄窗完整可用', async () => {
  await page.getByRole('button', { name: /^录音/ }).click()
  await expect(page.getByRole('button', { name: '开始录音', exact: true })).toBeVisible()
  if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, 'recording-idle.png') })
})
test('浏览器拒绝麦克风权限时显示设置入口，且不创建录音', async () => {
  await page.keyboard.press('ControlOrMeta+7')
  const before = await page.evaluate(() => window.jiwei.recording.list().then((r) => r.length))
  await page.evaluate(() => {
    const media = navigator.mediaDevices as MediaDevices & { originalCapture?: MediaDevices['getUserMedia'] }
    media.originalCapture = media.getUserMedia
    media.getUserMedia = async () => {
      throw new DOMException('Permission denied', 'NotAllowedError')
    }
  })
  try {
    await page.getByRole('button', { name: '开始录音', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('没有麦克风权限，请在系统设置中开启。')
    await expect(page.getByRole('button', { name: '打开系统设置', exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.jiwei.recording.list().then((r) => r.length))).toBe(before)
  } finally {
    await page.evaluate(() => {
      const media = navigator.mediaDevices as MediaDevices & { originalCapture?: MediaDevices['getUserMedia'] }
      media.getUserMedia = media.originalCapture!
      delete media.originalCapture
    })
  }
})
test('真实假麦克风录制二十秒、降级、标记、暂停与合并音轨', async () => {
  test.setTimeout(90000)
  await page.getByRole('button', { name: '随想', exact: true }).click()
  await page.getByRole('checkbox', { name: '系统音频', exact: true }).check()
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      throw new DOMException('Unsupported', 'NotSupportedError')
    }
  })
  await page.getByRole('button', { name: '开始录音', exact: true }).click()
  await expect(page.getByTestId('recorder')).toBeVisible()
  await expect(page.getByText('系统音频不可用，本次只录麦克风。')).toBeVisible()
  await expect(page.getByRole('button', { name: '刚才说什么', exact: true })).toBeDisabled()
  await page.getByRole('textbox', { name: '标记说明（可选）' }).fill('核对原声')
  await page.getByRole('button', { name: '重点（1）', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.jiwei.recording.list().then((r) => r[0]?.durationMs)), { timeout: 30000 })
    .toBeGreaterThanOrEqual(20000)
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.jiwei.recording.list().then((r) => r[0]?.status))).toBe('paused')
  await page.getByRole('button', { name: '继续', exact: true }).click()
  if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, 'recording-active.png') })
  await page.getByRole('button', { name: '结束', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.jiwei.recording.list().then((r) => r[0]?.status)), { timeout: 15000 }).toBe('ready')
  const r = await page.evaluate(() => window.jiwei.recording.list().then((r) => r[0]))
  expect(r.localOnly).toBe(true)
  expect(r.markers[0].text).toBe('核对原声')
  expect(r.tracks).toEqual(['mic'])
  const files = await app.evaluate(
    ({ app }, id) =>
      process.getBuiltinModule('fs').readdirSync(process.getBuiltinModule('path').join(app.getPath('userData'), 'recordings', id)),
    r.id
  )
  expect(files).toContain('mix.webm')
  expect(files).toContain('mic.webm')
  expect(files.filter((f) => /^mic-\d{6}\.webm$/.test(f))).toEqual([])
  await expect(page.getByTestId('media')).toBeVisible()
  await expect.poll(() => page.getByTestId('media').evaluate((m: HTMLMediaElement) => m.duration)).toBeGreaterThan(20)
  expect((await page.evaluate((id) => window.jiwei.sources.get(id), r.sourceId!))?.aiExcluded).toBe(true)
  await expect(page.getByText('结束后转写')).toHaveCount(0)
})
test('外部窗口及非法分块不能访问录音写入接口', async () => {
  await expect(
    page.evaluate(() =>
      window.jiwei.recording.chunk({ id: '../escape', track: 'mic', sequence: 0, startMs: 0, durationMs: 10, bytes: new Uint8Array([1]) })
    )
  ).rejects.toThrow()
  const next = app.waitForEvent('window')
  await page.evaluate(() => window.jiwei.capture.open('text'))
  const capture = await next
  await capture.waitForSelector('[data-testid="capture-window"]')
  await expect(capture.evaluate(() => window.jiwei.recording.list())).rejects.toThrow(/Forbidden/)
  await capture.close()
})
test('从笔记开始，浮动条可用且新增康奈尔行持久化录音时间戳', async () => {
  await page.keyboard.press('ControlOrMeta+n')
  await page.getByPlaceholder('笔记标题').fill('录音关联笔记')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: '在此笔记旁开始录音', exact: true }).click()
  await page.getByRole('button', { name: '开始录音', exact: true }).click()
  const bar = page.getByTestId('recording-floating')
  await expect(bar).toBeVisible()
  expect(await bar.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true)
  for (const name of ['暂停', '结束', '重点（1）', '决定（2）', '待办（3）'])
    await expect(bar.getByRole('button', { name, exact: true })).toBeVisible()
  if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, 'recording-floating.png') })
  await expect(bar).toContainText('0:02', { timeout: 10000 })
  await page.locator('.cornell-row .cornell-body p').last().click()
  await page.keyboard.press('ControlOrMeta+Enter')
  await page.keyboard.type('这行文字关联原声。')
  const row = page.locator('.cornell-row').last(),
    link = row.getByRole('link', { name: /▶ 0:/ })
  await expect(link).toBeVisible()
  const recording = (await page.evaluate(() => window.jiwei.recording.list()))[0]
  await expect(link).toHaveAttribute('href', new RegExp(`jiwei://source/${recording.id}\\?t=`))
  await expect
    .poll(async () => {
      const file = await page.evaluate((id) => window.jiwei.notes.export(id, 'md', {}), recording.noteId!)
      return app.evaluate((_electron, file) => process.getBuiltinModule('fs').readFileSync(file!, 'utf8'), file)
    })
    .toContain(`jiwei://source/${recording.id}?t=`)
  await bar.getByRole('button', { name: '结束', exact: true }).click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.recording.get(id).then((r) => r.status), recording.id)).toBe('ready')
})
test('写盘失败立即停止采集，已保存分块仍可恢复结束', async () => {
  test.setTimeout(60000)
  await page.keyboard.press('ControlOrMeta+7')
  await page.getByRole('button', { name: '开始录音', exact: true }).click()
  await expect(page.getByTestId('recorder')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.jiwei.recording.list().then((r) => r[0]?.durationMs ?? 0)), { timeout: 20000 })
    .toBeGreaterThanOrEqual(10000)
  const original = (await page.evaluate(() => window.jiwei.recording.list()))[0]
  await app.evaluate(({ app }, id) => {
    const path = process.getBuiltinModule('path'),
      fs = process.getBuiltinModule('fs')
    fs.chmodSync(path.join(app.getPath('userData'), 'recordings', id), 0o500)
  }, original.id)
  try {
    await expect(page.getByTestId('recorder')).toHaveCount(0, { timeout: 15000 })
    await expect(page.getByTestId('recording-recovery')).toBeVisible()
    await expect(page.getByRole('alert')).toContainText('录音写入失败，采集已停止')
  } finally {
    await app.evaluate(({ app }, id) => {
      const path = process.getBuiltinModule('path'),
        fs = process.getBuiltinModule('fs')
      fs.chmodSync(path.join(app.getPath('userData'), 'recordings', id), 0o700)
    }, original.id)
  }
  const saved = await page.evaluate((id) => window.jiwei.recording.get(id), original.id)
  await page.getByRole('button', { name: '恢复并结束', exact: true }).click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.recording.get(id).then((r) => r.status), original.id)).toBe('ready')
  expect((await page.evaluate((id) => window.jiwei.recording.get(id), original.id)).durationMs).toBe(saved.durationMs)
})
test('手机页面流式上传真音频，进入收件箱并归档成可回放录音资料', async () => {
  test.setTimeout(60000)
  const session = await page.evaluate(() => window.jiwei.phone.start())
  const next = app.waitForEvent('window')
  await app.evaluate(async ({ BrowserWindow }, url) => {
    const window = new BrowserWindow({ show: false })
    await window.loadURL(url)
  }, session.url)
  const phone = await next
  try {
    await expect(phone.getByRole('button', { name: '录音', exact: true })).toBeVisible()
    await phone.getByRole('textbox', { name: '备注', exact: true }).fill('手机音频入箱回放证据')
    await phone.locator('#files').setInputFiles(resolve('e2e/fixtures/meeting.wav'))
    await expect(phone.getByRole('status')).toHaveText('已收到', { timeout: 30000 })
    const item = await page.evaluate(() =>
      window.jiwei.inbox.list().then((items) => items.find((i) => i.text.includes('手机音频入箱回放证据')))
    )
    expect(item?.assetId).toBeNull()
    expect(item?.origin.sessionId).toBe(session.sessionId)
    const id = item!.origin.recordingSourceId!
    const source = await page.evaluate((id) => window.jiwei.sources.get(id), id)
    expect(source?.kind).toBe('recording')
    expect(source?.assetUrl).toContain('/recording/')
    const recording = (await page.evaluate(() => window.jiwei.recording.list())).find((r) => r.sourceId === id)!
    expect(recording.scene).toBe('unspecified')
    expect(recording.status).toBe('ready')
    expect(recording.durationMs).toBeGreaterThanOrEqual(44900)
    await page.keyboard.press('ControlOrMeta+0')
    await page.getByTestId(`inbox-${item!.id}`).getByRole('combobox', { name: '改为…', exact: true }).selectOption('save_source')
    await expect.poll(() => page.evaluate((id) => window.jiwei.inbox.get(id).then((i) => i?.status), item!.id)).toBe('filed')
    expect((await page.evaluate((id) => window.jiwei.inbox.get(id), item!.id))?.filedTo?.sourceIds).toEqual([id])
    await page.getByRole('checkbox', { name: '显示已归档和已忽略', exact: true }).check()
    await page.getByTestId(`inbox-${item!.id}`).getByRole('button', { name: '打开资料', exact: true }).click()
    await expect.poll(() => page.getByTestId('media').evaluate((m: HTMLMediaElement) => m.duration)).toBeGreaterThan(44)
  } finally {
    await phone.close()
    await page.evaluate((id) => window.jiwei.phone.stop(id), session.sessionId)
  }
})
// 会杀进程的用例放在文件末尾；重启后仍使用同一个隔离 userData。
test('强制中断后清单恢复、回收站可还原，再结束与原块时长一致', async () => {
  test.setTimeout(90000)
  await page.keyboard.press('ControlOrMeta+7')
  await page.getByRole('button', { name: '开始录音', exact: true }).click()
  await expect(page.getByTestId('recorder')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.jiwei.recording.list().then((r) => r[0].durationMs)), { timeout: 20000 })
    .toBeGreaterThanOrEqual(10000)
  const original = (await page.evaluate(() => window.jiwei.recording.list()))[0]
  const parts = await app.evaluate(({ app }, id) => {
    const path = process.getBuiltinModule('path'),
      fs = process.getBuiltinModule('fs')
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'recordings', id, 'manifest.json'), 'utf8')) as {
      parts: { durationMs: number; startMs: number }[]
    }
  }, original.id)
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()))
  app.process().kill('SIGKILL')
  await exited
  await launch()
  await page.keyboard.press('ControlOrMeta+7')
  await expect(page.getByTestId('recording-recovery')).toBeVisible()
  if (process.env.SHOTS_DIR) await page.screenshot({ path: join(process.env.SHOTS_DIR, 'recording-recovery.png') })
  await page.getByTestId('recording-recovery').getByRole('button', { name: '丢弃', exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate((id) => window.jiwei.trash.list().then((t) => t.some((i) => i.id === id && i.type === 'recording')), original.id)
    )
    .toBe(true)
  await page.getByRole('button', { name: /最近删除/ }).click()
  await expect(page.getByText('中断的录音', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '还原', exact: true }).click()
  await page.keyboard.press('ControlOrMeta+7')
  await page.getByRole('button', { name: '恢复并结束', exact: true }).click()
  await expect.poll(() => page.evaluate((id) => window.jiwei.recording.get(id).then((r) => r.status), original.id)).toBe('ready')
  const done = await page.evaluate((id) => window.jiwei.recording.get(id), original.id)
  expect(done.durationMs).toBe(Math.round(Math.max(...parts.parts.map((p) => p.startMs + p.durationMs))))
  await expect
    .poll(() => page.getByTestId('media').evaluate((m: HTMLMediaElement, ms) => Math.abs(m.duration * 1000 - ms), done.durationMs))
    .toBeLessThan(100)
})
