import { test, expect, _electron as electron } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 真实网络：更新安装包走加速镜像（v0.14.1）。默认跳过，JIWEI_UPDATE_LIVE=1 时运行。
// 本地更新源只提供版本信息：版本号改成更高、安装包地址写成 GitHub 发布仓库的真实地址、SHA-512 用真实值，
// 于是应用会对真实安装包做镜像测速、分段下载并校验（约 270 MB）。
test.skip(process.env.JIWEI_UPDATE_LIVE !== '1', '仅 JIWEI_UPDATE_LIVE=1 时运行')
for (const platform of ['darwin', 'win32'] as const)
  test(`${platform} 更新安装包经镜像下载并通过 SHA-512 校验`, async () => {
    test.setTimeout(20 * 60_000)
    const tag = process.env.JIWEI_UPDATE_LIVE_TAG ?? 'v0.14.0'
    const base = `https://github.com/cl3582175-oss/jiwei-releases/releases/download/${tag}/`
    const real = await (await fetch(`https://gh-proxy.com/${base}${platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml'}`)).text()
    // 只用 GitHub 上 latest-mac.yml 的 SHA-512 和大小；文件名改成绝对地址
    const yml = real
      .replace(/^version: .*$/m, 'version: 0.99.0')
      .replace(/(url|path): (Jiwei-[^\s]+)/g, (_m, k: string, f: string) => `${k}: ${base}${f}`)
    const root = mkdtempSync(join(tmpdir(), 'jiwei-update-live-'))
    const userData = join(root, 'user-data'),
      downloads = join(root, 'downloads'),
      appData = join(root, 'app-data')
    for (const d of [userData, downloads, appData]) mkdirSync(d, { recursive: true })
    const server = createServer((req, res) => {
      if (/latest(-mac)?\.yml/.test(req.url ?? '')) res.setHeader('content-type', 'text/yaml').end(yml)
      else res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const harness = join(root, 'main.cjs'),
      version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
    writeFileSync(
      harness,
      `const {app}=require('electron');app.setPath('userData',${JSON.stringify(userData)});app.setPath('appData',${JSON.stringify(appData)});app.getAppPath=()=>${JSON.stringify(process.cwd())};app.getVersion=()=>${JSON.stringify(version)};require(${JSON.stringify(join(process.cwd(), 'out/main/index.js'))});`
    )
    const app = await electron.launch({
      args: [harness, `--user-data-dir=${userData}`],
      env: {
        ...process.env,
        JIWEI_LANG: 'zh-CN',
        JIWEI_SKIP_ONBOARDING: '1',
        JIWEI_IMPORT_PROVIDERS_FROM: '',
        JIWEI_UPDATE_FORCE_PACKAGED: '1',
        JIWEI_UPDATE_FEED: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
        JIWEI_UPDATE_DOWNLOADS: downloads,
        JIWEI_UPDATE_PLATFORM: platform
      }
    })
    try {
      const page = await app.firstWindow()
      await page.waitForSelector('nav')
      await page.getByRole('button', { name: /^设置/ }).click()
      await page.getByRole('button', { name: '关于', exact: true }).click({ timeout: 5000 })
      await page.getByRole('button', { name: '检查更新', exact: true }).click()
      const started = Date.now()
      // Windows 自动模式发现新版本后直接下载；macOS 需要点“下载更新”
      if (platform === 'darwin') {
        await expect(page.getByTestId('update-settings')).toContainText('发现新版本 0.99.0')
        await page.getByRole('button', { name: '下载更新', exact: true }).click()
      }
      await expect(page.getByTestId('update-settings')).toContainText(/来源 (gh-proxy\.com|ghfast\.top|github\.com)/, { timeout: 60_000 })
      const shown = await page.getByTestId('update-settings').innerText()
      console.log('[live] progress:', /正在下载[^\n]*/.exec(shown)?.[0])
      if (platform === 'darwin') {
        await expect(page.getByTestId('update-replace-guide')).toBeVisible({ timeout: 18 * 60_000 })
        const dmg = readdirSync(downloads).find((n) => n.endsWith('.dmg'))!
        console.log(
          '[live]',
          platform,
          'done in',
          Math.round((Date.now() - started) / 1000),
          's, size',
          statSync(join(downloads, dmg)).size
        )
      } else {
        // electron-updater 下载完成并校验 SHA-512 后才出现“重新启动以更新”
        await expect(page.getByRole('button', { name: '重新启动以更新', exact: true })).toBeVisible({ timeout: 18 * 60_000 })
        console.log('[live]', platform, 'done in', Math.round((Date.now() - started) / 1000), 's')
      }
    } finally {
      await app.close()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
