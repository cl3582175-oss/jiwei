import { test, expect, type Locator } from '@playwright/test'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { execFileSync } from 'child_process'
import { startSafetyApp, settingsData, pickSave, ffmpeg } from './fixtures/safetyApp'
import { startSite } from './fixtures/browserPage'
import { navTo } from './fixtures/nav'

// 独立运行的视觉验收。全部界面使用实际操作状态；耗时的真实数据种子不放进默认全套。
test.skip(process.env.JIWEI_BACKUP_UI !== '1', 'JIWEI_BACKUP_UI=1 生成并核查完整四组截图')
test.setTimeout(900000)
const folder = resolve(process.env.SHOTS_DIR ?? `.superpowers/sdd/2026-10-10-backup-and-safety/evidence/ui-${Date.now()}`)
const qfl = process.env.JIWEI_REAL_VIDEOS ?? ''
const videos = ['043', '041', '045'].map((n) => join(qfl, `QFL-VIDEO-${n}/05-审阅候选/QFL-VIDEO-${n}_审阅候选_v1.mp4`))

test('备份、恢复码、迁移与浏览器：两种尺寸 × 浅深主题逐屏截图与字号／溢出检查', async () => {
  mkdirSync(folder, { recursive: true })
  const site = await startSite()
  let env = await startSafetyApp({ env: { JIWEI_TEST_LOGIN_BLOCK_HOSTS: '127.0.0.1' } })
  const checks: unknown[] = []
  const capture = async (name: string, scope: Locator, page = env.page): Promise<void> => {
    await scope.scrollIntoViewIfNeeded()
    const layout = await scope.evaluate((el) => {
      const nodes = [el, ...el.querySelectorAll('*')].filter((n) => {
        const r = n.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && getComputedStyle(n).visibility !== 'hidden'
      })
      const sizes = nodes
        .filter((n) => [...n.childNodes].some((c) => c.nodeType === Node.TEXT_NODE && c.textContent?.trim()))
        .map((n) => ({ text: n.textContent?.trim().slice(0, 70), px: parseFloat(getComputedStyle(n).fontSize) }))
      return {
        minFont: Math.min(...sizes.map((n) => n.px)),
        bodyFonts: nodes.filter((n) => n.classList.contains('text-sm')).map((n) => parseFloat(getComputedStyle(n).fontSize)),
        sizes,
        overflow: el.scrollWidth > el.clientWidth + 1,
        bodyOverflow: document.documentElement.scrollWidth > innerWidth,
        theme: document.documentElement.dataset.theme
      }
    })
    expect(layout.minFont, `${name} 的辅助说明字号`).toBeGreaterThanOrEqual(12)
    for (const px of layout.bodyFonts) expect(px, `${name} 的正文实际字号`).toBeGreaterThanOrEqual(14)
    expect(layout.overflow, `${name} 的内容横向溢出`).toBe(false)
    expect(layout.bodyOverflow, `${name} 的窗口横向溢出`).toBe(false)
    checks.push({ name, ...layout })
    if (/-01-backup-empty$|-02-backup-list$/.test(name)) {
      const records = scope.getByRole('heading', { name: '备份记录', exact: true }).locator('..')
      await records.evaluate((el) => el.scrollIntoView({ block: 'end', behavior: 'instant' }))
      await expect(records).toBeInViewport({ ratio: 1 })
    }
    await page.screenshot({ path: join(folder, `${name}.png`), animations: 'disabled' })
    writeFileSync(join(folder, 'layout-checks.json'), JSON.stringify(checks, null, 2))
  }
  let seeded = false
  try {
    for (const [width, height] of [
      [1440, 900],
      [1000, 680]
    ])
      for (const theme of ['light', 'dark'] as const) {
        const prefix = `${theme}-${width}x${height}`
        await env.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height])
        await env.page.evaluate((theme) => window.jiwei.settings.set({ theme }), theme)
        if (seeded) {
          await env.page.evaluate(() => window.jiwei.recording.encryption(false, true))
          await expect
            .poll(() => env.page.evaluate(() => window.jiwei.recording.cryptoStatus().then((s) => s.progress.state)), { timeout: 60000 })
            .toBe('done')
        }
        // 仅清理本测试创建的备份，形成真实空列表，不替换接口返回值。
        rmSync(join(env.userData, 'data/backups'), { recursive: true, force: true })
        mkdirSync(join(env.userData, 'data/backups'), { recursive: true })
        await env.page.reload()
        await env.page.waitForSelector('nav')
        await settingsData(env)
        await capture(`${prefix}-01-backup-empty`, env.page.getByTestId('backup-settings'))
        await env.page.keyboard.press('Escape')
        if (!seeded) {
          const chunks = join(env.userData, 'visual-audio')
          mkdirSync(chunks)
          execFileSync(ffmpeg, [
            '-nostdin',
            '-v',
            'error',
            '-i',
            videos[1],
            '-t',
            '410',
            '-map',
            '0:a:0',
            '-vn',
            '-c:a',
            'libopus',
            '-b:a',
            '512k',
            '-f',
            'segment',
            '-segment_time',
            '10',
            '-reset_timestamps',
            '1',
            '-y',
            join(chunks, 'part-%03d.webm')
          ])
          const names = readdirSync(chunks)
            .filter((n) => n.endsWith('.webm'))
            .sort()
            .slice(0, 41)
          for (let index = 0; index < 4; index++) {
            const r = await env.page.evaluate(() =>
              window.jiwei.recording.begin({ scene: 'thought', tracks: ['mic'], localOnly: true, participants: [], extraHotwords: '' })
            )
            for (const [sequence, name] of names.entries())
              await env.page.evaluate(
                ({ id, sequence, base64 }) =>
                  window.jiwei.recording.chunk({
                    id,
                    track: 'mic',
                    sequence,
                    startMs: sequence * 10000,
                    durationMs: 10000,
                    bytes: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
                  }),
                { id: r.id, sequence, base64: readFileSync(join(chunks, name)).toString('base64') }
              )
            await env.page.evaluate((id) => window.jiwei.recording.finish(id), r.id)
          }
          // 结束合成会压缩至 64 kbps 并清理分段，四条完成录音的迁移不到一次 UI 轮询。
          // 保留四条真实双轨、7 分钟的待恢复录音，让迁移截图能观察到实际已处理量。
          // 每条通过 begin/chunk/pause 创建；重启释放活动录音身份，文件仍由产品路径保留。
          const currentUserData = env.userData
          for (let index = 0; index < 4; index++) {
            const r = await env.page.evaluate(() =>
              window.jiwei.recording.begin({
                scene: 'thought',
                tracks: ['mic', 'system'],
                localOnly: true,
                participants: [],
                extraHotwords: ''
              })
            )
            for (const [sequence, name] of names.entries())
              for (const track of ['mic', 'system'] as const)
                await env.page.evaluate(
                  ({ id, sequence, track, base64 }) =>
                    window.jiwei.recording.chunk({
                      id,
                      track,
                      sequence,
                      startMs: sequence * 10000,
                      durationMs: 10000,
                      bytes: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
                    }),
                  { id: r.id, sequence, track, base64: readFileSync(join(chunks, name)).toString('base64') }
                )
            await env.page.evaluate((id) => window.jiwei.recording.pause(id, true), r.id)
            await env.close()
            env = await startSafetyApp({ userData: currentUserData, env: { JIWEI_TEST_LOGIN_BLOCK_HOSTS: '127.0.0.1' } })
          }
          await env.page.evaluate((paths) => window.jiwei.sources.importPaths(paths), videos)
          seeded = true
        }
        await settingsData(env)
        await env.page.getByTestId('recording-security').scrollIntoViewIfNeeded()
        await env.page.getByRole('button', { name: '启用加密', exact: true }).click()
        await env.page.getByRole('button', { name: '生成恢复码', exact: true }).click()
        await expect(env.page.getByTestId('generated-recovery-code')).toBeVisible()
        const code = (await env.page.getByTestId('generated-recovery-code').innerText()).trim()
        await capture(`${prefix}-05-recovery-enable`, env.page.getByTestId('recovery-code-dialog'))
        await env.page.getByRole('textbox', { name: '恢复码最后一组' }).fill(code.slice(-4))
        await env.page.getByRole('button', { name: '确认并启用加密', exact: true }).click()
        await expect(env.page.getByTestId('recording-security').getByRole('progressbar')).toBeVisible({ timeout: 15000 })
        await expect(env.page.getByTestId('recording-security')).toContainText(/MB \/ .*MB/, { timeout: 15000 })
        await capture(`${prefix}-08-encryption-progress`, env.page.getByTestId('recording-security'))
        await expect
          .poll(() => env.page.evaluate(() => window.jiwei.recording.cryptoStatus().then((s) => s.progress.state)), { timeout: 60000 })
          .toBe('done')
        await env.page.getByTestId('backup-settings').scrollIntoViewIfNeeded()
        await env.page.getByRole('button', { name: '立即备份', exact: true }).click()
        await expect
          .poll(() => env.page.evaluate(() => window.jiwei.backups.status().then((s) => s.progress.state)), { timeout: 60000 })
          .toBe('done')
        await expect(env.page.getByRole('button', { name: '恢复此备份' }).first()).toBeVisible()
        await capture(`${prefix}-02-backup-list`, env.page.getByTestId('backup-settings'))
        await pickSave(env, join(env.userData, `${prefix}.jiwei`))
        await env.page.getByRole('button', { name: '导出备份文件…', exact: true }).click()
        await expect(env.page.getByTestId('backup-settings').getByRole('progressbar')).toBeVisible()
        await capture(`${prefix}-03-backup-progress`, env.page.getByTestId('backup-settings'))
        await expect
          .poll(() => env.page.evaluate(() => window.jiwei.backups.status().then((s) => s.progress.state)), { timeout: 60000 })
          .toBe('done')
        await env.page.getByRole('button', { name: '恢复此备份' }).first().click()
        await capture(`${prefix}-04-restore-preview`, env.page.getByTestId('restore-preview'))
        await env.page.getByRole('radio', { name: /替换当前知识库/ }).check()
        await capture(`${prefix}-06-restore-choice`, env.page.getByTestId('restore-preview'))
        await env.page.getByRole('button', { name: '取消', exact: true }).click()
        await env.page.keyboard.press('Escape')
        await navTo(env.page, /录音/)
        await expect(env.page.getByLabel('已加密', { exact: true }).first()).toBeVisible()
        await capture(`${prefix}-07-encrypted-list`, env.page.getByLabel('已加密', { exact: true }).first().locator('..'))
        const currentUserData = env.userData
        await env.close()
        const fresh = await startSafetyApp({ vault: join(currentUserData, 'data') })
        try {
          await fresh.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height])
          await fresh.page.evaluate((theme) => window.jiwei.settings.set({ theme }), theme)
          await navTo(fresh.page, /录音/)
          await fresh.page.getByLabel('已加密', { exact: true }).first().locator('..').click()
          await expect(fresh.page.getByRole('textbox', { name: '录音恢复码' })).toBeVisible()
          const hint = await fresh.page.getByTestId('recording-locked-hint').evaluate((el) => ({
            font: parseFloat(getComputedStyle(el).fontSize),
            overflow: el.scrollWidth > el.clientWidth + 1
          }))
          expect(hint).toEqual({ font: 14, overflow: false })
          await capture(`${prefix}-09-recovery-input`, fresh.page.getByTestId('recovery-code-dialog'), fresh.page)
          Object.assign(checks.at(-1) as object, { playerLockedHint: hint })
          await fresh.page.getByRole('textbox', { name: '录音恢复码', exact: true }).fill(code)
          await fresh.page.getByRole('button', { name: '解锁录音', exact: true }).click()
          await expect(fresh.page.getByTestId('recording-locked-hint')).toHaveCount(0)
          await expect.poll(() => fresh.page.getByTestId('media').evaluate((m: HTMLAudioElement) => m.readyState)).toBeGreaterThanOrEqual(1)
        } finally {
          await fresh.close()
        }
        env = await startSafetyApp({ userData: currentUserData, env: { JIWEI_TEST_LOGIN_BLOCK_HOSTS: '127.0.0.1' } })
        await env.app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), [width, height])
        await settingsData(env)
        await env.page.getByRole('dialog').getByRole('button', { name: '浏览器', exact: true }).click()
        await env.page.getByRole('button', { name: 'bilibili（含视频 CDN）设为直连', exact: true }).click()
        await expect(env.page.getByTestId('browser-safety-settings')).toContainText('bilivideo.com')
        await capture(`${prefix}-10-website-network`, env.page.getByTestId('browser-safety-settings'))
        await env.page.keyboard.press('Escape')
        await env.page.keyboard.press('ControlOrMeta+n')
        await env.page.getByPlaceholder('笔记标题').fill('浏览器安全界面验收')
        await env.page.keyboard.press('Enter')
        await env.page.getByRole('button', { name: '在笔记旁打开浏览器' }).click()
        const id = await env.page.evaluate((url) => window.jiwei.browser.open(url, { newTab: true }), `${site.base}/article`)
        await expect
          .poll(() => env.page.evaluate((id) => window.jiwei.browser.state().then((s) => s.tabs.find((t) => t.id === id)?.loading), id))
          .toBe(false)
        await env.page.evaluate(({ id, url }) => window.jiwei.browser.navigate(id, url), { id, url: `${site.base}/signin/rejected` })
        await expect(env.page.getByTestId('browser-login-warning')).toBeVisible()
        await capture(`${prefix}-11-browser-warning`, env.page.getByTestId('browser-login-warning'))
        for (const tab of (await env.page.evaluate(() => window.jiwei.browser.state())).tabs)
          await env.page.evaluate((id) => window.jiwei.browser.close(id), tab.id)
      }
    writeFileSync(join(folder, 'layout-checks.json'), JSON.stringify(checks, null, 2))
  } finally {
    await env.close()
    site.server.close()
  }
})
