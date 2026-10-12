import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export async function updateFixture(
  options: { platform?: 'darwin' | 'win32'; corrupt?: boolean; offline?: boolean; userData?: string; delay?: number } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'jiwei-update-e2e-'))
  const userData = options.userData ?? join(root, 'user-data'),
    downloads = join(root, 'downloads'),
    appData = join(root, 'app-data')
  for (const directory of [userData, downloads, appData]) mkdirSync(directory, { recursive: true })
  const bytes = Buffer.alloc(2 * 1024 * 1024, 65),
    sha512 = createHash('sha512').update(bytes).digest('base64')
  const requests: string[] = []
  const metadata = { version: '1.0.0', corrupt: options.corrupt ?? false }
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    if (options.offline) {
      response.writeHead(503).end('Controlled update server unavailable')
      return
    }
    if (/latest(?:-mac|-linux)?\.yml/.test(request.url ?? '')) {
      const files = [
        `Jiwei-${metadata.version}-mac-arm64.dmg`,
        `Jiwei-${metadata.version}-mac-x64.dmg`,
        `Jiwei-${metadata.version}-win-x64.exe`
      ].map((url) => ({
        url,
        sha512,
        size: bytes.length
      }))
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      response.setHeader('content-type', 'text/yaml')
      response.end(
        `version: ${metadata.version}\nreleaseNotes: ${JSON.stringify(`# 原创更新说明\n- 本地真实更新路径\n<script data-update-injection>never()</script>\n![tracking](${base}/tracking.png)\n[unsafe](javascript:never())`)}\nfiles:\n${files.map((f) => `  - url: ${f.url}\n    sha512: ${f.sha512}\n    size: ${f.size}`).join('\n')}\npath: ${files[0].url}\nsha512: ${sha512}\n`
      )
      return
    }
    if (/\.(dmg|exe)$/.test(request.url ?? '')) {
      const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? ''),
        start = match ? Number(match[1]) : 0,
        end = match?.[2] ? Math.min(bytes.length - 1, Number(match[2])) : bytes.length - 1
      const content = metadata.corrupt ? Buffer.alloc(bytes.length, 66) : bytes
      response.writeHead(match ? 206 : 200, {
        'content-length': end - start + 1,
        ...(match ? { 'content-range': `bytes ${start}-${end}/${bytes.length}` } : {})
      })
      let offset = start
      const interval = setInterval(() => {
        const next = Math.min(end + 1, offset + 64 * 1024)
        response.write(content.subarray(offset, next))
        offset = next
        if (offset > end) {
          clearInterval(interval)
          response.end()
        }
      }, 30)
      response.on('close', () => clearInterval(interval))
      return
    }
    response.writeHead(404).end('Unknown update fixture route')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const feed = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  const harness = join(root, 'main.cjs'),
    version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version
  writeFileSync(
    harness,
    `const {app}=require('electron');app.setPath('userData',${JSON.stringify(userData)});app.setPath('appData',${JSON.stringify(appData)});app.getAppPath=()=>${JSON.stringify(process.cwd())};app.getVersion=()=>${JSON.stringify(version)};require(${JSON.stringify(join(process.cwd(), 'out/main/index.js'))});`
  )
  let app: ElectronApplication
  try {
    app = await electron.launch({
      args: [harness, `--user-data-dir=${userData}`],
      env: {
        ...process.env,
        JIWEI_LANG: 'zh-CN',
        JIWEI_SKIP_ONBOARDING: '1',
        JIWEI_IMPORT_PROVIDERS_FROM: '',
        JIWEI_UPDATE_FORCE_PACKAGED: '1',
        JIWEI_UPDATE_FEED: feed,
        JIWEI_UPDATE_DOWNLOADS: downloads,
        JIWEI_UPDATE_PLATFORM: options.platform ?? 'darwin',
        JIWEI_UPDATE_CHECK_DELAY: String(options.delay ?? 30000)
      }
    })
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw error
  }
  const page: Page = await app.firstWindow()
  await page.waitForSelector('nav')
  return {
    root,
    userData,
    downloads,
    app,
    page,
    requests,
    metadata,
    close: async () => {
      await app.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
