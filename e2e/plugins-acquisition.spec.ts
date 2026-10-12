import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { createServer } from 'http'
import JSZip from 'jszip'

test('P2A isolated production IPC: marketplace → owned acquisition → preview token → persistent installation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jiwei-p2a-ipc-'))
  const userData = join(root, 'user-data'),
    appData = join(root, 'app-data')
  mkdirSync(userData)
  mkdirSync(appData)
  const catalog = {
    name: 'ipc-market',
    owner: { name: 'Self-authored fixture' },
    plugins: [{ name: 'ipc-plugin', source: './plugins/example', version: '1.0.0' }]
  }
  const zip = new JSZip()
  zip.file('repo/.claude-plugin/marketplace.json', JSON.stringify(catalog))
  zip.file('repo/plugins/example/.claude-plugin/plugin.json', JSON.stringify({ name: 'ipc-plugin', version: '1.0.0' }))
  zip.file(
    'repo/plugins/example/skills/read/SKILL.md',
    '---\nname: read\ndescription: Self authored IPC evidence\n---\nRead verifiable evidence.'
  )
  zip.file('repo/plugins/example/README.md', '# Fixture\n<script>never()</script>')
  const archive = await zip.generateAsync({ type: 'nodebuffer' })
  const server = createServer((req, res) => {
    if (req.url === '/repos/fixture/repo') res.end(JSON.stringify({ default_branch: 'main' }))
    else if (req.url === '/fixture/repo/main/.claude-plugin/marketplace.json') res.end(JSON.stringify(catalog))
    else if (req.url === '/fixture/repo/zip/main') res.end(archive)
    else {
      res.statusCode = 404
      res.end('fixture route missing')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const harness = join(root, 'main.cjs')
  writeFileSync(
    harness,
    `const {app}=require('electron');app.setPath('userData',${JSON.stringify(userData)});app.setPath('appData',${JSON.stringify(appData)});app.getAppPath=()=>${JSON.stringify(process.cwd())};require(${JSON.stringify(join(process.cwd(), 'out/main/index.js'))});`
  )
  const env = {
    ...process.env,
    JIWEI_SKIP_ONBOARDING: '1',
    JIWEI_LANG: 'en',
    JIWEI_TEST_NETWORK: '1',
    JIWEI_IMPORT_PROVIDERS_FROM: '',
    JIWEI_GITHUB_RAW: base,
    JIWEI_GITHUB_CODELOAD: base,
    JIWEI_GITHUB_API: base
  }
  delete env.ELECTRON_RUN_AS_NODE
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: [harness, `--user-data-dir=${userData}`], env })
    let page = await app.firstWindow()
    await page.waitForSelector('nav')
    const result = await page.evaluate(async () => {
      const api = window.jiwei.plugins
      const initial = await api.markets()
      await api.addMarket({ kind: 'github', url: 'fixture/repo' })
      const cards = await api.catalog()
      const operation = await api.beginAcquisition()
      const result = await api.acquire(operation, { kind: 'market', market: 'ipc-market', name: 'ipc-plugin' })
      if (result.kind !== 'plugin') throw new Error('Expected production preview')
      const details = await api.details({ token: result.preview.token })
      let invalidRejected = false
      try {
        await api.confirmInstall('0'.repeat(64), { feeds: [], config: {} })
      } catch {
        invalidRejected = true
      }
      const installed = await api.confirmInstall(result.preview.token, { feeds: [], config: {} })
      await api.cancelAcquisition(operation)
      return { initial, cards, invalidRejected, installed, readme: details.readme }
    })
    expect(result.initial).toEqual([expect.objectContaining({ name: 'jiwei', builtin: true })])
    // 内置官方市场自带角色包；这里只核对测试市场里的条目
    expect(result.cards.filter((c) => c.origin.market === 'ipc-market')).toEqual([
      expect.objectContaining({ name: 'ipc-plugin', supported: true })
    ])
    expect(result.invalidRejected).toBe(true)
    expect(result.installed.id).toBe('ipc-plugin@ipc-market')
    expect(result.readme).toContain('&lt;script&gt;')
    await app.close()
    app = await electron.launch({ args: [harness, `--user-data-dir=${userData}`], env })
    page = await app.firstWindow()
    await page.waitForSelector('nav')
    const persisted = await page.evaluate(async () => {
      const skills = await window.jiwei.skills.list()
      await window.jiwei.plugins.removeMarket('ipc-market', { uninstall: false })
      let denied = false
      try {
        await window.jiwei.plugins.update('ipc-plugin@ipc-market')
      } catch {
        denied = true
      }
      const plugins = await window.jiwei.plugins.list()
      await window.jiwei.plugins.uninstall('ipc-plugin@ipc-market', { removeFeeds: false, removeTasks: false })
      return { skills, plugins, denied }
    })
    expect(persisted.plugins).toHaveLength(1)
    expect(persisted.plugins[0].available).toBe(true)
    expect(persisted.skills.some((s) => s.name === 'ipc-plugin:read')).toBe(true)
    expect(persisted.denied).toBe(true)
    // 只替代原生选择器，识别、市场快照、preview、确认与持久化均走 production IPC。
    for (const kind of ['folder', 'zip']) {
      const localPath = join(root, `My Market (1)${kind === 'zip' ? '.zip' : ''}`)
      const files = {
        '.claude-plugin/marketplace.json': JSON.stringify({
          name: 'local-market',
          owner: { name: 'Self-authored local fixture' },
          plugins: [{ name: 'local-plugin', source: './plugins/example' }]
        }),
        'plugins/example/.claude-plugin/plugin.json': JSON.stringify({ name: 'local-plugin', version: '1.0.0' }),
        'plugins/example/skills/read/SKILL.md': '---\nname: read\ndescription: Local acquisition evidence\n---\nRead local evidence.',
        'unrelated/large.md': 'x'.repeat(2 * 1024 * 1024)
      }
      const localZip = new JSZip()
      for (const [name, value] of Object.entries(files)) {
        if (kind === 'zip') localZip.file(`repo-main/${name}`, value)
        else {
          mkdirSync(dirname(join(localPath, name)), { recursive: true })
          writeFileSync(join(localPath, name), value)
        }
      }
      if (kind === 'zip') writeFileSync(localPath, await localZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
      }, localPath)
      const localResult = await page.evaluate(async () => {
        const api = window.jiwei.plugins
        const operation = await api.beginAcquisition()
        const detected = await api.acquireFile(operation)
        if (detected?.kind !== 'market') throw new Error('Expected local market')
        await api.addDetectedMarket(operation, detected.token)
        await api.cancelAcquisition(operation)
        const installOperation = await api.beginAcquisition()
        const preview = await api.acquire(installOperation, { kind: 'market', market: 'local-market', name: 'local-plugin' })
        if (preview.kind !== 'plugin') throw new Error('Expected local plugin preview')
        const installed = await api.confirmInstall(preview.preview.token, { feeds: [], config: {} })
        await api.cancelAcquisition(installOperation)
        const skills = await window.jiwei.skills.list()
        await api.removeMarket('local-market', { uninstall: true })
        return { detected, installed, skills }
      })
      expect(localResult.detected.name).toBe('local-market')
      expect(localResult.installed.id).toBe('local-plugin@local-market')
      expect(localResult.skills.some((s) => s.name === 'local-plugin:read')).toBe(true)
    }
    const pluginPath = join(root, 'My Plugin (1).zip')
    const writeWrapped = async (version: string) => {
      const source = new JSZip()
      source.file('repo-main/.claude-plugin/plugin.json', JSON.stringify({ name: 'wrapped-plugin', version }))
      source.file('repo-main/skills/read/SKILL.md', '---\nname: read\ndescription: Wrapped evidence\n---\nRead evidence.')
      writeFileSync(pluginPath, await source.generateAsync({ type: 'nodebuffer' }))
    }
    await writeWrapped('1.0.0')
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, pluginPath)
    const localInstalled = await page.evaluate(async () => {
      const api = window.jiwei.plugins
      const operation = await api.beginAcquisition()
      const detected = await api.acquireFile(operation)
      if (detected?.kind !== 'plugin') throw new Error('Expected wrapped plugin')
      const installed = await api.confirmInstall(detected.preview.token, { feeds: [], config: {} })
      await api.cancelAcquisition(operation)
      return installed
    })
    expect(localInstalled.id).toBe('wrapped-plugin@local')
    await app.close()
    await writeWrapped('2.0.0')
    app = await electron.launch({ args: [harness, `--user-data-dir=${userData}`], env })
    page = await app.firstWindow()
    await page.waitForSelector('nav')
    const updated = await page.evaluate(async () => {
      const api = window.jiwei.plugins
      const operation = await api.beginAcquisition()
      const preview = await api.acquireUpdate(operation, 'wrapped-plugin@local')
      await api.confirmInstall(preview.token, { feeds: [], config: {} })
      await api.cancelAcquisition(operation)
      const installed = await api.get('wrapped-plugin@local')
      const skills = await window.jiwei.skills.list()
      await api.uninstall('wrapped-plugin@local', { removeFeeds: false, removeTasks: false })
      return { installed, skills }
    })
    expect(updated.installed.version).toBe('2.0.0')
    expect(updated.skills.some((s) => s.name === 'wrapped-plugin:read')).toBe(true)
  } finally {
    await app?.close().catch(() => undefined)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  }
})
