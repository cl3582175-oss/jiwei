import { test, expect } from '@playwright/test'
import { existsSync, readdirSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import { startSafetyApp, injectRecording, enableEncryption, settingsData, type SafetyApp } from './fixtures/safetyApp'
import { navTo } from './fixtures/nav'

let env: SafetyApp, code: string
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  env = await startSafetyApp({ allModels: true })
})
test.afterAll(async () => {
  await env?.close()
})
test('实际启用与恢复码确认、直接密文写块、字幕、合成、Range 播放', async () => {
  test.setTimeout(90000)
  await settingsData(env)
  await env.page.getByRole('button', { name: '启用加密', exact: true }).click()
  await env.page.getByRole('button', { name: '生成恢复码', exact: true }).click()
  code = (await env.page.getByTestId('generated-recovery-code').innerText()).trim()
  await env.page.getByRole('textbox', { name: '恢复码最后一组' }).fill('XXXX')
  await env.page.getByRole('button', { name: '确认并启用加密', exact: true }).click()
  await expect(env.page.getByRole('alert')).toContainText('不匹配')
  await env.page.getByRole('textbox', { name: '恢复码最后一组' }).fill(code.slice(-4))
  await env.page.getByRole('button', { name: '确认并启用加密', exact: true }).click()
  await expect.poll(() => env.page.evaluate(() => window.jiwei.recording.cryptoStatus().then((s) => s.encryption))).toBe('on')
  const r = await injectRecording(env, { finish: false })
  const folder = join(env.userData, 'data/recordings', r.id)
  expect(readdirSync(folder)).toContain('mic-000000.webm.enc')
  expect(
    readdirSync(folder).some((name) =>
      readFileSync(join(folder, name))
        .subarray(0, 4)
        .equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    )
  ).toBe(false)
  const completed = await env.page.evaluate((id) => window.jiwei.recording.finish(id), r.id)
  expect(completed.encrypted).toBe(true)
  expect(readdirSync(folder).filter((n) => n.endsWith('.webm'))).toEqual([])
  const range = await env.page.evaluate(async (id) => {
    const all = await fetch(`jiwei://recording/${id}`),
      bytes = new Uint8Array(await all.arrayBuffer()),
      range = await fetch(`jiwei://recording/${id}`, { headers: { Range: 'bytes=29-133' } })
    return {
      status: range.status,
      header: range.headers.get('content-range'),
      bytes: [...new Uint8Array(await range.arrayBuffer())],
      expected: [...bytes.slice(29, 134)]
    }
  }, completed.sourceId!)
  expect(range.status).toBe(206)
  expect(range.bytes).toEqual(range.expected)
  expect(range.header).toContain('bytes 29-133/')
  await expect
    .poll(
      () =>
        env.page.evaluate(() =>
          window.jiwei.jobs
            .list()
            .then((j) => j.filter((j) => j.kind === 'recording.preview').every((j) => ['done', 'canceled'].includes(j.status)))
        ),
      { timeout: 30000 }
    )
    .toBe(true)
})
test('新用户目录必须输入恢复码，输错报错，输对后可读音频', async () => {
  const fresh = await startSafetyApp({ vault: join(env.userData, 'data') })
  try {
    expect((await fresh.page.evaluate(() => window.jiwei.recording.cryptoStatus())).unlocked).toBe(false)
    const recording = (await fresh.page.evaluate(() => window.jiwei.recording.list()))[0]
    expect(await fresh.page.evaluate(async (id) => (await fetch(`jiwei://recording/${id}`)).status, recording.sourceId!)).toBe(423)
    await expect(fresh.page.evaluate(() => window.jiwei.recording.unlock('0000-0000-0000-0000-0000-0000'))).rejects.toThrow(/不正确/)
    await fresh.app.evaluate(({ session }) => {
      const rows: unknown[] = []
      Object.assign(globalThis, { recordingPlayerResponses: rows })
      session.defaultSession.webRequest.onCompleted({ urls: ['<all_urls>'] }, (details) => {
        if (details.url.startsWith('jiwei://recording/'))
          rows.push({ at: Date.now(), status: details.statusCode, url: details.url, type: details.resourceType })
      })
    })
    await fresh.page.evaluate(() => {
      const rows: unknown[] = []
      Object.assign(window, { recordingPlayerEvents: rows })
      for (const type of ['loadstart', 'abort', 'emptied', 'error', 'loadedmetadata'])
        document.addEventListener(
          type,
          (event) => {
            const m = event.target as HTMLAudioElement
            if (m.tagName === 'AUDIO') rows.push({ at: Date.now(), type, src: m.src, ready: m.readyState, error: m.error?.message })
          },
          true
        )
    })
    await navTo(fresh.page, /录音/)
    await fresh.page.getByLabel('已加密', { exact: true }).first().locator('..').click()
    await expect(fresh.page.getByRole('textbox', { name: '录音恢复码', exact: true })).toBeVisible()
    expect(await fresh.page.getByTestId('media').evaluate((m: HTMLAudioElement) => m.currentSrc)).toBe('')
    await fresh.page.getByRole('textbox', { name: '录音恢复码', exact: true }).fill('0000-0000-0000-0000-0000-0000')
    await fresh.page.getByRole('button', { name: '解锁录音', exact: true }).click()
    await expect(fresh.page.getByRole('alert')).toContainText('不正确')
    await fresh.page.getByRole('textbox', { name: '录音恢复码', exact: true }).fill(code)
    await fresh.page.getByRole('button', { name: '解锁录音', exact: true }).click()
    await expect(fresh.page.getByTestId('recording-locked-hint')).toHaveCount(0)
    try {
      await expect
        .poll(() => fresh.page.getByTestId('media').evaluate((m: HTMLAudioElement) => m.readyState), { timeout: 10000 })
        .toBeGreaterThanOrEqual(1)
    } catch (error) {
      console.log(
        JSON.stringify({
          playerUnlockFailure: await fresh.page.evaluate(async (id) => {
            const m = document.querySelector('[data-testid="media"]') as HTMLAudioElement
            const r = await fetch(`jiwei://recording/${id}`, { headers: { Range: 'bytes=0-200' } })
            return {
              events: (window as typeof window & { recordingPlayerEvents: unknown[] }).recordingPlayerEvents,
              crypto: await window.jiwei.recording.cryptoStatus(),
              player: {
                src: m.src,
                currentSrc: m.currentSrc,
                readyState: m.readyState,
                networkState: m.networkState,
                error: m.error?.message,
                errorCode: m.error?.code
              },
              range: { status: r.status, bytes: (await r.arrayBuffer()).byteLength, headers: [...r.headers] }
            }
          }, recording.sourceId!),
          responses: await fresh.app.evaluate(
            () => (globalThis as typeof globalThis & { recordingPlayerResponses: unknown[] }).recordingPlayerResponses
          )
        })
      )
      throw error
    }
    await fresh.page.getByTestId('media').evaluate(async (m: HTMLAudioElement) => {
      m.currentTime = 1
      await m.play()
    })
    await expect.poll(() => fresh.page.getByTestId('media').evaluate((m: HTMLAudioElement) => m.currentTime)).toBeGreaterThan(1)
    await fresh.page.getByTestId('media').evaluate((m: HTMLAudioElement) => m.pause())
    expect(
      await fresh.page.evaluate(
        async (id) => (await fetch(`jiwei://recording/${id}`, { headers: { Range: 'bytes=0-3' } })).status,
        recording.sourceId!
      )
    ).toBe(206)
  } finally {
    await fresh.close()
  }
})
test('二次确认关闭加密、存量迁移完成后重启与旧位置迁入', async () => {
  test.setTimeout(90000)
  await expect(env.page.evaluate(() => window.jiwei.recording.encryption(false, false))).rejects.toThrow(/确认/)
  await env.page.evaluate(() => window.jiwei.recording.encryption(false, true))
  await expect
    .poll(() => env.page.evaluate(() => window.jiwei.recording.cryptoStatus().then((s) => s.progress.state)), { timeout: 30000 })
    .toBe('done')
  const r = (await env.page.evaluate(() => window.jiwei.recording.list()))[0]
  expect(existsSync(join(env.userData, 'data/recordings', r.id, 'mix.webm'))).toBe(true)
  await enableEncryption(env)
  const userData = env.userData
  await env.close()
  const oldRoot = join(userData, 'recordings')
  const fs = await import('fs')
  fs.mkdirSync(oldRoot, { recursive: true })
  renameSync(join(userData, 'data/recordings', r.id), join(oldRoot, r.id))
  env = await startSafetyApp({ userData })
  expect(existsSync(join(userData, 'data/recordings', r.id, 'mix.webm.enc'))).toBe(true)
  expect(existsSync(join(oldRoot, r.id))).toBe(false)
})
