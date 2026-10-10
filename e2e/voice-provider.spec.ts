import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

test('真实服务商从预览字幕给一句话总结，内容保留字幕关键词', async () => {
  test.skip(!process.env.JIWEI_IMPORT_PROVIDERS_FROM, '由审查者提供真实服务商配置；不读取或打印凭证')
  test.setTimeout(240000)
  const app = await electron.launch({
    args: [
      '.',
      `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-voice-provider-'))}`,
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${resolve('e2e/fixtures/meeting.wav')}`
    ],
    env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    expect((await page.evaluate(() => window.jiwei.asr.status())).state).toBe('ready')
    await page.keyboard.press('ControlOrMeta+7')
    await page.getByRole('button', { name: '会议', exact: true }).click()
    await page.getByRole('button', { name: '开始录音', exact: true }).click()
    await expect(page.getByTestId('recorder')).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => window.jiwei.recording.list().then((r) => r[0]?.preview.map((c) => c.text).join('') ?? '')), {
        timeout: 60000
      })
      .toMatch(/复习|概念|课堂/)
    const r = (await page.evaluate(() => window.jiwei.recording.list()))[0]
    const summary = await page.evaluate((id) => window.jiwei.recording.summarize(id), r.id)
    expect(summary).toMatch(/复习|概念|课堂/)
    expect(summary.length).toBeLessThan(300)
    await page.getByRole('button', { name: '结束', exact: true }).click()
    await expect.poll(() => page.evaluate((id) => window.jiwei.recording.get(id).then((r) => r.status), r.id)).toBe('ready')
  } finally {
    await app.close()
  }
})
