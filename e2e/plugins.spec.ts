import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname, basename } from 'path'
import { createServer, type Server } from 'http'
import JSZip from 'jszip'
import { navTo } from './fixtures/nav'
import { pluginResponseGateHarness } from './fixtures/plugin-response-gates'

// These assertions catch bypassed trust/token confirmation, missing registry consumers,
// unsafe README requests, lost source state, and cancellation that only hides the UI.
test.describe.configure({ mode: 'serial' })
let app: ElectronApplication, page: Page, server: Server, root: string, userData: string, base: string
let version = 1,
  failRisk = true,
  slowStarted = 0,
  slowClosed = 0
const archives = new Map<string, Buffer>()
let evidenceDirectory: string
const shots = process.env.SHOTS_DIR
const fixtureRoot = join(process.cwd(), 'e2e/fixtures/plugins')
const manifest = JSON.parse(readFileSync(join(fixtureRoot, 'market-sample/.claude-plugin/marketplace.json'), 'utf8'))
function zipFolder(zip: JSZip, path: string, prefix = '') {
  for (const name of readdirSync(path)) {
    const full = join(path, name),
      dest = prefix + name
    if (statSync(full).isDirectory()) zipFolder(zip, full, dest + '/')
    else zip.file(dest, readFileSync(full))
  }
}
async function packages() {
  const market = new JSZip()
  zipFolder(market, join(fixtureRoot, 'market-sample'), 'repo-main/')
  const plugin = JSON.parse(readFileSync(join(fixtureRoot, 'market-sample/plugins/evidence/.claude-plugin/plugin.json'), 'utf8'))
  plugin.version = `${version}.0.0`
  if (version > 1) plugin.mcpServers = { 'update-connector': { command: 'p2-never-run', args: [] } }
  market.file('repo-main/plugins/evidence/.claude-plugin/plugin.json', JSON.stringify(plugin))
  market.file(
    'repo-main/plugins/evidence/jiwei/sources.json',
    JSON.stringify({ feeds: [{ url: `${base}/feed.xml`, title: '市场自编源', kind: 'rss' }] })
  )
  archives.set('market', await market.generateAsync({ type: 'nodebuffer' }))
  const reserved = new JSZip()
  reserved.file('reserved-main/.claude-plugin/marketplace.json', JSON.stringify({ ...manifest, name: 'jiwei-fake' }))
  archives.set('reserved', await reserved.generateAsync({ type: 'nodebuffer' }))
  const risk = new JSZip()
  zipFolder(risk, join(fixtureRoot, 'risk-sample'), 'risk-main/')
  archives.set('risk', await risk.generateAsync({ type: 'nodebuffer' }))
  const skills = new JSZip()
  zipFolder(skills, join(fixtureRoot, 'skills-sample'), 'skills-main/')
  archives.set('skills', await skills.generateAsync({ type: 'nodebuffer' }))
  const direct = new JSZip()
  direct.file('direct-main/.claude-plugin/plugin.json', JSON.stringify({ name: 'p2-direct', version: '1.0.0' }))
  direct.file('direct-main/skills/read/SKILL.md', '---\nname: read\ndescription: Direct fixture\n---\nRead direct evidence.')
  archives.set('direct', await direct.generateAsync({ type: 'nodebuffer' }))
  archives.set('race-skills', archives.get('skills')!)
  const raceMarket = new JSZip()
  raceMarket.file(
    'race-main/.claude-plugin/marketplace.json',
    JSON.stringify({ name: 'p2-race-market', owner: { name: 'Self-authored race' }, plugins: [] })
  )
  archives.set('race-market', await raceMarket.generateAsync({ type: 'nodebuffer' }))
  for (const branch of ['skills', 'market']) {
    const next = await JSZip.loadAsync(archives.get('direct')!)
    next.file('direct-main/.claude-plugin/plugin.json', JSON.stringify({ name: `p2-race-${branch}`, version: '1.0.0' }))
    archives.set(`race-new-${branch}`, await next.generateAsync({ type: 'nodebuffer' }))
  }
}
async function settings() {
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('button', { name: '插件', exact: true }).click()
}
async function marketTab() {
  await page.getByRole('button', { name: '市场', exact: true }).click()
}
async function installedTab() {
  await page.getByRole('group', { name: '插件', exact: true }).getByRole('button', { name: '已安装', exact: true }).click()
}
function card(name = 'p2-evidence') {
  return page.locator(`[data-catalog-id="${name}@p2-market"]`)
}
function installed(id = 'p2-evidence@p2-market') {
  return page.locator(`[data-plugin-id="${id}"]`)
}
/** 已安装列表只有启用开关；更新、回滚、文件夹、卸载在“管理”对话框里 */
async function manage(id = 'p2-evidence@p2-market') {
  await installed(id).getByRole('button', { name: '管理', exact: true }).click()
  return page.getByTestId('plugin-details')
}
/** 第三方市场的状态行只在出错或选中该市场时显示 */
async function marketRow(name: string) {
  await page.getByRole('combobox', { name: '全部市场', exact: true }).selectOption(name)
  return page.locator(`[data-market-name="${name}"]`)
}
async function github(repo: string) {
  await page.getByRole('button', { name: '从 GitHub 安装', exact: true }).click()
  await page.getByTestId('plugin-github').getByRole('textbox').fill(repo)
  await page.getByTestId('plugin-github').getByRole('button', { name: '继续', exact: true }).click()
}
async function shot(name: string) {
  if (shots) {
    mkdirSync(shots, { recursive: true })
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 8000 })
    await page.screenshot({ path: join(shots, name + '.png'), animations: 'disabled' })
  }
}
async function closeSettings() {
  await page.keyboard.press('Escape')
}
async function picker(path: string) {
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, path)
}
test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'jiwei-p2-ui-'))
  userData = join(root, 'userData')
  const appData = join(root, 'appData')
  mkdirSync(userData)
  mkdirSync(appData)
  server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url === '/https-market.json') {
      res.end(JSON.stringify({ name: 'p2-https', owner: { name: 'Self-authored HTTPS' }, plugins: [] }))
      return
    }
    if (url === '/feed.xml') {
      res.end(
        '<rss version="2.0"><channel><title>Self authored</title><link>https://example.org</link><description>Evidence</description></channel></rss>'
      )
      return
    }
    const repo = url.match(/(?:\/repos)?\/fixture\/([^/]+)/)?.[1]
    if (url.includes('/commits/')) {
      res.statusCode = 404
      res.end('Use manifest version')
      return
    }
    if (url === `/repos/fixture/${repo}`) {
      res.end(JSON.stringify({ default_branch: 'main' }))
      return
    }
    if (repo === 'market' && url.endsWith('/.claude-plugin/marketplace.json')) {
      res.end(JSON.stringify(manifest))
      return
    }
    if (repo === 'race-market' && url.endsWith('/.claude-plugin/marketplace.json')) {
      res.end(JSON.stringify({ name: 'p2-race-market', owner: { name: 'Self-authored race' }, plugins: [] }))
      return
    }
    if (repo === 'reserved' && url.endsWith('/.claude-plugin/marketplace.json')) {
      res.end(JSON.stringify({ ...manifest, name: 'jiwei-fake' }))
      return
    }
    if (url.includes('/zip/')) {
      if (repo === 'slow') {
        slowStarted++
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': 1000000 })
        res.write(Buffer.alloc(1024))
        const timer = setInterval(() => res.write(Buffer.alloc(1024)), 30)
        res.on('close', () => {
          slowClosed++
          clearInterval(timer)
        })
        return
      }
      if (repo === 'corrupt' && !archives.has('corrupt')) {
        res.end('not a zip archive')
        return
      }
      if (repo === 'risk' && failRisk) {
        res.statusCode = 503
        res.end('Controlled enrichment failure')
        return
      }
      if (archives.has(repo!)) {
        res.end(archives.get(repo!)!)
        return
      }
    }
    res.statusCode = 404
    res.end('Self-authored route missing')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await packages()
  const harness = join(root, 'main.cjs')
  writeFileSync(
    harness,
    `const {app}=require('electron');app.setPath('userData',${JSON.stringify(userData)});app.setPath('appData',${JSON.stringify(appData)});app.getAppPath=()=>${JSON.stringify(process.cwd())};${pluginResponseGateHarness};require(${JSON.stringify(join(process.cwd(), 'out/main/index.js'))});`
  )
  const env = {
    ...process.env,
    JIWEI_SKIP_ONBOARDING: '1',
    JIWEI_LANG: 'zh-CN',
    JIWEI_TEST_NETWORK: '1',
    JIWEI_IMPORT_PROVIDERS_FROM: '',
    JIWEI_GITHUB_RAW: base,
    JIWEI_GITHUB_CODELOAD: base,
    JIWEI_GITHUB_API: base
  }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [harness, `--user-data-dir=${userData}`], env })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 900))
})
test.afterAll(async () => {
  await app?.close().catch(() => undefined)
  server?.closeAllConnections()
  if (server) await new Promise<void>((r) => server.close(() => r()))
  if (root) rmSync(root, { recursive: true, force: true })
})

test('offline official catalog, explicit trust, partial enrichment error/retry, bilingual search and filters', async () => {
  await settings()
  await marketTab()
  await expect(page.getByRole('combobox', { name: '全部市场', exact: true }).locator('option', { hasText: '积微官方' })).toHaveCount(1)
  expect((await page.evaluate(() => window.jiwei.plugins.markets())).map((m) => m.name)).toEqual(['jiwei'])
  await page.getByRole('button', { name: '不再推荐', exact: true }).click()
  expect((await page.evaluate(() => window.jiwei.settings.get())).plugins.recommendedDismissed).toBe(true)
  await github('fixture/market')
  const detect = page.getByTestId('plugin-acquisition')
  await expect(detect).toContainText('Self-authored P2 fixture')
  await shot('p2-market-trust')
  expect((await page.evaluate(() => window.jiwei.plugins.markets())).map((m) => m.name)).toEqual(['jiwei'])
  await detect.getByRole('button', { name: '我信任这个来源，添加市场' }).click()
  await expect(detect).toHaveCount(0)
  const row = page.locator('[data-market-name="p2-market"]')
  await expect(row.getByRole('alert')).toBeVisible()
  expect((await page.evaluate(() => window.jiwei.plugins.markets())).find((m) => m.name === 'p2-market')?.fetchedAt).toBeNull()
  await expect(card()).toBeVisible()
  await shot('p2-market-partial-error')
  failRisk = false
  await row.getByRole('button', { name: '重试', exact: true }).click()
  await expect(row.getByRole('alert')).toHaveCount(0)
  expect((await page.evaluate(() => window.jiwei.plugins.markets())).find((m) => m.name === 'p2-market')?.fetchedAt).toBeTruthy()
  await page.getByRole('textbox', { name: '搜索名称、简介或关键词' }).fill('证据')
  await expect(card()).toBeVisible()
  await expect(card('p2-risk')).toHaveCount(0)
  await page.getByRole('textbox', { name: '搜索名称、简介或关键词' }).fill('EVIDENCE')
  await expect(card()).toBeVisible()
  await page.getByRole('combobox', { name: '类别', exact: true }).selectOption('connector')
  await expect(card()).toHaveCount(0)
  await page.getByRole('button', { name: '清除筛选', exact: true }).click()
  await expect(card('p2-risk')).toBeVisible()
  await expect(card('p2-npm')).toContainText(/不支持/)
  await expect(card('p2-npm').getByRole('button', { name: '安装', exact: true })).toBeDisabled()
  await expect(card().locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/)
  await shot('p2-market-light')
  await card().scrollIntoViewIfNeeded()
  await shot('p2-market-cards-light')
})

test('safe README details, system browser link, real pure-text install and registry consumers', async () => {
  const requested: string[] = []
  page.on('request', (r) => requested.push(r.url()))
  await card().locator('[data-open-details]').click()
  const detail = page.getByTestId('plugin-details')
  await expect(detail).toBeVisible()
  await expect(detail.getByTestId('plugin-readme')).toContainText('Read evidence')
  await expect(detail.getByTestId('plugin-readme').locator('img,script')).toHaveCount(0)
  await expect(detail.getByTestId('plugin-readme').locator('a[href^="javascript:"]')).toHaveCount(0)
  expect(requested.some((url) => /should-not-load/.test(url))).toBe(false)
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url) => {
      ;(globalThis as typeof globalThis & { opened?: string }).opened = url
    }
  })
  await detail.getByRole('link', { name: 'Safe external reference' }).click()
  await expect
    .poll(() => app.evaluate(() => (globalThis as typeof globalThis & { opened?: string }).opened))
    .toBe('https://example.org/p2-evidence')
  await shot('p2-details-light')
  await detail.getByRole('button', { name: '安装', exact: true }).click()
  const confirm = page.getByTestId('plugin-confirm')
  await expect(confirm).toContainText('只包含文字内容，不运行任何程序')
  await expect(confirm.getByRole('button', { name: '安装', exact: true })).toBeFocused()
  await confirm.getByRole('button', { name: '安装', exact: true }).click()
  await expect(card()).toContainText('已安装')
  await card().locator('[data-open-details]').click()
  await expect(page.getByTestId('plugin-details')).toBeVisible()
  await expect(page.getByTestId('plugin-details').getByRole('button', { name: '停用', exact: true })).toBeVisible()
  await expect(page.getByTestId('plugin-details').getByRole('button', { name: '卸载', exact: true })).toBeVisible()
  await page.getByTestId('plugin-details').getByRole('button', { name: '关闭', exact: true }).last().click()
  await installedTab()
  await app.evaluate(({ shell }) => {
    shell.openPath = async (path) => {
      ;(globalThis as typeof globalThis & { openedPath?: string }).openedPath = path
      return ''
    }
  })
  await (await manage()).getByRole('button', { name: '打开插件文件夹', exact: true }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { openedPath?: string }).openedPath)).toBeTruthy()
  evidenceDirectory = (await app.evaluate(() => (globalThis as typeof globalThis & { openedPath?: string }).openedPath))!
  expect(evidenceDirectory.startsWith(join(userData, 'plugins/cache/'))).toBe(true)
  expect(existsSync(join(evidenceDirectory, '.claude-plugin/plugin.json'))).toBe(true)
  await page.getByTestId('plugin-details').getByRole('button', { name: 'p2-evidence:read', exact: true }).click()
  await expect(page.getByText('p2-evidence:read', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('p2-evidence:check', { exact: true }).first()).toBeVisible()
  await closeSettings()
  await navTo(page, /^作品/)
  await page.getByRole('button', { name: /图文长文/ }).click()
  await page.getByTestId('new-work-dialog').getByLabel('作品模板').selectOption('p2-evidence:article')
  await expect(page.getByTestId('new-work-dialog').getByLabel('选题')).toHaveValue('')
  await shot('p2-template')
  await page.keyboard.press('Escape')
  await navTo(page, /^参谋/)
  await page.getByLabel('用分析框架').selectOption('p2-evidence:decision')
  await shot('p2-framework')
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('button', { name: 'AI 任务', exact: true }).click()
  await page.getByRole('button', { name: '市场证据任务', exact: true }).click()
  await expect(page.getByLabel('任务名称')).toHaveValue('市场证据任务')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  expect((await page.evaluate(() => window.jiwei.tasks.list()))[0].pluginId).toBe('p2-evidence@p2-market')
  await closeSettings()
  await settings()
  await marketTab()
})

test('risky connector focus, config presence/change/clear, disabled MCP and narrow English/dark details', async () => {
  await card('p2-risk').getByRole('button', { name: '安装', exact: true }).click()
  const confirm = page.getByTestId('plugin-confirm')
  await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeFocused()
  await expect(confirm).toContainText('运行程序')
  await shot('p2-risk-confirm')
  await confirm.getByLabel('合成配置').fill('synthetic-p2-only')
  await expect(confirm.getByLabel('合成配置')).toHaveAttribute('type', 'password')
  await confirm.getByRole('button', { name: '安装', exact: true }).click()
  await expect(confirm).toHaveCount(0)
  await installedTab()
  const detail = await manage('p2-risk@p2-market')
  await detail.locator('summary').filter({ hasText: '配置' }).click()
  await expect(detail).toContainText('已设置')
  await expect(detail.getByLabel('合成配置')).toHaveValue('')
  expect(JSON.stringify(await page.evaluate(() => window.jiwei.plugins.get('p2-risk@p2-market')))).not.toContain('synthetic-p2-only')
  expect((await page.evaluate(() => window.jiwei.mcp.servers()))[0].enabled).toBe(false)
  await detail.getByLabel('合成配置').fill('synthetic-p2-replaced')
  await detail.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(detail.getByLabel('合成配置')).toHaveValue('')
  await detail.getByRole('button', { name: '清除这项配置', exact: true }).click()
  await detail.getByRole('button', { name: '取消', exact: true }).click()
  expect((await page.evaluate(() => window.jiwei.plugins.get('p2-risk@p2-market'))).sensitive.key).toBe(true)
  await detail.getByRole('button', { name: '清除这项配置', exact: true }).click()
  await detail.getByRole('button', { name: '清除这项配置', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.plugins.get('p2-risk@p2-market'))).sensitive.key).toBe(false)
  await page.evaluate(() => window.jiwei.settings.set({ theme: 'dark', language: 'en' }))
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setMinimumSize(640, 640)
    win.setSize(760, 760)
  })
  await expect(detail).toContainText('Not set')
  expect(await detail.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await shot('p2-details-dark-narrow-english')
  await detail.getByText('Third-party market · p2-market', { exact: true }).scrollIntoViewIfNeeded()
  await shot('p2-details-top-dark-narrow-english')
  await detail.getByRole('button', { name: 'Close', exact: true }).last().click()
  const marketButton = page.getByRole('button', { name: 'Marketplace', exact: true })
  await marketButton.click()
  await expect(marketButton).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('plugin-marketplace')).toBeVisible()
  await shot('p2-market-dark-narrow-english')
  await card().scrollIntoViewIfNeeded()
  await shot('p2-market-cards-dark-narrow-english')
  await page.evaluate(() => window.jiwei.settings.set({ theme: 'light', language: 'zh-CN' }))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1360, 900))
})

test('cached update indicator, capability reconfirm, rollback, disable, uninstall retaining user data with no owned directories', async () => {
  version = 2
  await packages()
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(card()).toContainText('有更新')
  await expect(page.getByLabel('有更新', { exact: true })).toBeVisible()
  await card().getByRole('button', { name: '更新', exact: true }).click()
  const confirm = page.getByTestId('plugin-confirm')
  await expect(confirm).toContainText('新增能力')
  await expect(confirm).toContainText('update-connector')
  await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeFocused()
  await confirm.getByRole('button', { name: '更新并同意新的能力' }).click()
  await expect(card()).toContainText('2.0.0')
  await installedTab()
  await (await manage()).getByRole('button', { name: /回滚/ }).click()
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.plugins.get('p2-evidence@p2-market'))).version).toBe('1.0.0')
  await page.keyboard.press('Escape')
  await installed().getByRole('switch').click()
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.skills.list())).some((s) => s.pluginId === 'p2-evidence@p2-market'))
    .toBe(false)
  expect((await page.evaluate(() => window.jiwei.plugins.templates())).some((s) => s.pluginId === 'p2-evidence@p2-market')).toBe(false)
  expect((await page.evaluate(() => window.jiwei.plugins.frameworks())).some((s) => s.pluginId === 'p2-evidence@p2-market')).toBe(false)
  expect((await page.evaluate(() => window.jiwei.tasks.recipes())).some((s) => s.id === 'p2-evidence:review')).toBe(false)
  await (await manage()).getByRole('button', { name: '卸载', exact: true }).click()
  const dialog = page.getByTestId('plugin-uninstall')
  await expect(dialog.getByLabel('同时删除订阅源')).not.toBeChecked()
  await expect(dialog.getByLabel('同时删除任务')).not.toBeChecked()
  await dialog.getByRole('button', { name: '卸载', exact: true }).click()
  await expect(installed()).toHaveCount(0)
  expect((await page.evaluate(() => window.jiwei.discover.feeds())).find((f) => f.title === '市场自编源')?.pluginId).toBeNull()
  expect((await page.evaluate(() => window.jiwei.tasks.list()))[0].pluginId).toBeNull()
  expect(existsSync(dirname(evidenceDirectory))).toBe(false)
  expect(existsSync(join(userData, 'plugins/data', basename(dirname(evidenceDirectory))))).toBe(false)
  expect(readdirSync(join(userData, 'plugins/cache'))).toHaveLength(1)
  expect(readdirSync(join(userData, 'plugins/data'))).toHaveLength(1)
})

test('direct detection: duplicate/reserved market, selected Agent Skills, GitHub plugin/subdir, zip and retained market state', async () => {
  await github('fixture/market')
  await page.getByTestId('plugin-acquisition').getByRole('button', { name: '我信任这个来源，添加市场' }).click()
  await expect(page.getByTestId('plugin-acquisition').getByRole('alert')).toContainText(/exists|已存在/)
  await page.getByTestId('plugin-acquisition').getByRole('button', { name: '取消', exact: true }).click()
  await github('fixture/reserved')
  await expect(page.getByTestId('plugin-acquisition').getByRole('alert')).toContainText(/reserved|保留/i)
  await page.getByTestId('plugin-acquisition').getByRole('button', { name: '取消', exact: true }).click()
  await github('fixture/skills')
  const selection = page.getByTestId('plugin-acquisition')
  await expect(selection.getByRole('checkbox')).toHaveCount(2)
  await selection.getByRole('checkbox').nth(1).uncheck()
  await shot('p2-skills-selection')
  await selection.getByRole('button', { name: '继续', exact: true }).click()
  await page.getByTestId('plugin-confirm').getByRole('button', { name: '安装', exact: true }).click()
  await expect(page.getByTestId('plugin-confirm')).toHaveCount(0)
  const collection = (await page.evaluate(() => window.jiwei.plugins.list())).find((p) => p.origin.selection?.length === 1)!
  expect(collection).toBeTruthy()
  const selectedSkills = (await page.evaluate(() => window.jiwei.skills.list())).filter((s) => s.pluginId === collection.id)
  expect(selectedSkills).toHaveLength(1)
  expect(selectedSkills[0].name).toContain('alpha')
  await github('fixture/direct')
  await page.getByTestId('plugin-confirm').getByRole('button', { name: '安装', exact: true }).click()
  await expect(installed('p2-direct@local')).toBeVisible()
  await expect(installed('p2-direct@local')).toContainText('GitHub')
  await github('fixture/risk')
  await expect(page.getByTestId('plugin-acquisition').getByRole('alert')).toContainText('先卸载旧来源')
  await page.getByTestId('plugin-acquisition').getByRole('button', { name: '取消', exact: true }).click()
  await github('https://github.com/fixture/market/tree/main/plugins/evidence')
  await expect(page.getByTestId('plugin-confirm')).toContainText('自编证据插件')
  await page.getByTestId('plugin-confirm').getByRole('button', { name: '取消', exact: true }).click()
  await page.evaluate(() => window.jiwei.plugins.uninstall('p2-direct@local', { removeFeeds: false, removeTasks: false }))
  const archive = join(root, 'direct.zip')
  writeFileSync(archive, archives.get('direct')!)
  await picker(archive)
  await page.getByRole('button', { name: '从文件安装', exact: true }).click()
  await expect(page.getByTestId('plugin-confirm')).toBeVisible()
  await page
    .getByTestId('plugin-confirm')
    .getByRole('button', { name: /更新|安装/, exact: false })
    .last()
    .click()
  await expect(page.getByTestId('plugin-confirm')).toHaveCount(0)
  await marketTab()
  await (await marketRow('p2-market')).getByRole('button', { name: '删除市场', exact: true }).click()
  const remove = page.getByTestId('plugin-remove-market')
  await expect(remove.getByRole('checkbox')).toBeChecked()
  await remove.getByRole('checkbox').uncheck()
  await remove.getByRole('button', { name: '删除市场', exact: true }).click()
  await installedTab()
  await expect(installed('p2-risk@p2-market')).toContainText('不能更新')
  await expect((await manage('p2-risk@p2-market')).getByRole('button', { name: '更新', exact: true })).toBeDisabled()
  await page.getByTestId('plugin-details').getByRole('button', { name: '关闭', exact: true }).last().click()
})

test('local market replacement keeps retained-source update denial; HTTPS addition requires trust and stays on the real main path', async () => {
  const newerRisk = await JSZip.loadAsync(archives.get('risk')!)
  const riskManifest = JSON.parse(await newerRisk.file('risk-main/.claude-plugin/plugin.json')!.async('string'))
  riskManifest.version = '2.0.0'
  newerRisk.file('risk-main/.claude-plugin/plugin.json', JSON.stringify(riskManifest))
  archives.set('risk', await newerRisk.generateAsync({ type: 'nodebuffer' }))
  await picker(join(fixtureRoot, 'market-sample'))
  await page.getByRole('button', { name: '从文件安装', exact: true }).click()
  await expect(page.getByTestId('plugin-acquisition')).toContainText('Self-authored P2 fixture')
  await page.getByTestId('plugin-acquisition').getByRole('button', { name: '我信任这个来源，添加市场' }).click()
  await expect(page.getByTestId('plugin-acquisition')).toHaveCount(0)
  await expect(installed('p2-risk@p2-market')).toContainText('不能更新')
  await expect((await manage('p2-risk@p2-market')).getByRole('button', { name: '更新', exact: true })).toBeDisabled()
  await page.getByTestId('plugin-details').getByRole('button', { name: '关闭', exact: true }).last().click()
  expect((await page.evaluate(() => window.jiwei.plugins.catalog())).find((p) => p.id === 'p2-risk@p2-market')?.updateAvailable).toBe(false)
  // Redirect only the transport for this self-authored HTTPS fixture, retaining URL validation,
  // actual HTTP bytes, market parsing, persistence, and error handling.
  await app.evaluate(({ net }, base) => {
    const original = net.fetch.bind(net)
    net.fetch = (input, init) =>
      original(String(input) === 'https://fixture.invalid/marketplace.json' ? `${base}/https-market.json` : input, init)
  }, base)
  await marketTab()
  await page.getByRole('button', { name: '添加市场', exact: true }).click()
  const add = page.getByTestId('plugin-add-market')
  await add.getByRole('combobox').selectOption('url')
  await add.getByRole('textbox').fill('https://fixture.invalid/marketplace.json')
  await expect(add.getByRole('button', { name: '我信任这个来源，添加市场' })).toBeDisabled()
  await expect(add).toContainText('fixture.invalid')
  await add.getByRole('checkbox').check()
  await add.getByRole('button', { name: '我信任这个来源，添加市场' }).click()
  await expect(await marketRow('p2-https')).toBeVisible()
  await page.getByRole('combobox', { name: '全部市场', exact: true }).selectOption('')
  expect((await page.evaluate(() => window.jiwei.plugins.markets())).find((m) => m.name === 'p2-https')?.source).toContain(
    'fixture.invalid'
  )
  await expect(page.getByLabel('有更新', { exact: true })).toHaveCount(0)
  await expect(card('p2-risk')).toContainText('不能更新')
  await card('p2-risk').locator('[data-open-details]').click()
  await expect(page.getByTestId('plugin-details')).toContainText('不能更新')
  await expect(page.getByTestId('plugin-details').getByRole('link', { name: /仓库/ })).toHaveAttribute(
    'href',
    'https://github.com/fixture/market'
  )
  await page.getByTestId('plugin-details').getByRole('button', { name: '关闭', exact: true }).last().click()
  await marketTab()
  await (await marketRow('p2-market')).getByRole('button', { name: '删除市场', exact: true }).click()
  await expect(page.getByTestId('plugin-remove-market').getByRole('checkbox')).toBeChecked()
  await page.getByTestId('plugin-remove-market').getByRole('button', { name: '删除市场', exact: true }).click()
  await expect(page.getByTestId('plugin-remove-market')).toHaveCount(0)
  expect((await page.evaluate(() => window.jiwei.plugins.list())).some((p) => p.id === 'p2-risk@p2-market')).toBe(true)
  await installedTab()
})

test('download cancel before preview aborts real stream; corruption leaves no state and retry remains usable', async () => {
  const before = (await page.evaluate(() => window.jiwei.plugins.list())).map((p) => p.id)
  const tempBefore = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('jiwei-plugin-')))
  const cacheBefore = readdirSync(join(userData, 'plugins/cache')).sort()
  await github('fixture/slow')
  await expect.poll(() => slowStarted).toBeGreaterThan(0)
  await expect(page.getByTestId('plugin-acquisition').getByRole('status')).toBeVisible()
  await shot('p2-download-progress')
  await page.getByTestId('plugin-acquisition').getByRole('button', { name: '取消', exact: true }).click()
  await expect.poll(() => slowClosed).toBeGreaterThan(0)
  await expect(page.getByTestId('plugin-confirm')).toHaveCount(0)
  await github('fixture/corrupt')
  await expect(page.getByTestId('plugin-acquisition').getByRole('alert')).toBeVisible()
  await shot('p2-corrupt-retry')
  const repaired = await JSZip.loadAsync(archives.get('direct')!)
  repaired.file('direct-main/.claude-plugin/plugin.json', JSON.stringify({ name: 'p2-recovered', version: '1.0.0' }))
  archives.set('corrupt', await repaired.generateAsync({ type: 'nodebuffer' }))
  await page.getByTestId('plugin-acquisition').getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByTestId('plugin-confirm')).toContainText('p2-recovered')
  await page.getByTestId('plugin-confirm').getByRole('button', { name: '取消', exact: true }).click()
  expect((await page.evaluate(() => window.jiwei.plugins.list())).map((p) => p.id)).toEqual(before)
  expect(readdirSync(join(userData, 'plugins/cache')).sort()).toEqual(cacheBefore)
  await expect.poll(() => readdirSync(join(userData, 'plugins/previews'))).toEqual([])
  await expect.poll(() => readdirSync(tmpdir()).filter((n) => n.startsWith('jiwei-plugin-') && !tempBefore.has(n))).toEqual([])
})

// A late response from choose must not overwrite or close the next acquisition.
// Gates delay real IPC results after the original main handler has completed.
for (const branch of ['skills', 'market'] as const) {
  test(`P2B-I1 canceled ${branch} response cannot replace or close the next acquisition`, async () => {
    const previews = () => (existsSync(join(userData, 'plugins/previews')) ? readdirSync(join(userData, 'plugins/previews')) : [])
    type Gate = { waiting?: boolean; released?: boolean; release?: () => void }
    type GateHost = typeof globalThis & { p2ResponseGates: Record<string, Gate>; p2HeldResponses: Record<string, Gate> }
    const arm = async (channel: string) => {
      await app.evaluate((_, channel) => {
        const host = globalThis as GateHost
        host.p2HeldResponses ??= {}
        host.p2ResponseGates[channel] = host.p2HeldResponses[channel] = {}
      }, channel)
    }
    const waiting = async (channel: string) => {
      await expect.poll(() => app.evaluate((_, channel) => (globalThis as GateHost).p2HeldResponses[channel]?.waiting, channel)).toBe(true)
    }
    const release = async (channel: string) => {
      await app.evaluate((_, channel) => (globalThis as GateHost).p2HeldResponses[channel].release!(), channel)
      await expect.poll(() => app.evaluate((_, channel) => (globalThis as GateHost).p2HeldResponses[channel].released, channel)).toBe(true)
      // Allow the delivered IPC promise and React render to settle before asserting
      // absence; an immediate absence assertion could miss the stale callback.
      await page.waitForTimeout(100)
    }
    await page.keyboard.press('Escape')
    await settings()
    await github(`fixture/race-${branch}`)
    const acquisition = page.getByTestId('plugin-acquisition')
    await expect(acquisition).toContainText(branch === 'skills' ? '选择要安装的技能' : 'Self-authored race')
    const oldChannel = branch === 'skills' ? 'plugins:list' : 'plugins:addDetectedMarket'
    await arm(oldChannel)
    await acquisition.getByRole('button', { name: branch === 'skills' ? '继续' : '我信任这个来源，添加市场', exact: true }).click()
    await waiting(oldChannel)
    if (branch === 'skills') expect(previews()).toHaveLength(1)
    else expect((await page.evaluate(() => window.jiwei.plugins.markets())).some((m) => m.name === 'p2-race-market')).toBe(true)
    await acquisition.getByRole('button', { name: '取消', exact: true }).click()
    await expect(acquisition).toHaveCount(0)
    await expect.poll(() => previews()).toEqual([])
    await arm('plugins:acquire')
    await github(`fixture/race-new-${branch}`)
    await waiting('plugins:acquire')
    const nextPreviews = previews()
    expect(nextPreviews).toHaveLength(1)
    await release(oldChannel)
    await expect(page.getByTestId('plugin-confirm')).toHaveCount(0)
    await expect(acquisition.getByRole('status')).toBeVisible()
    expect(previews()).toEqual(nextPreviews)
    await release('plugins:acquire')
    const confirmation = page.getByTestId('plugin-confirm')
    await expect(confirmation).toContainText(`p2-race-${branch}`)
    await confirmation.getByRole('button', { name: '安装', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    expect((await page.evaluate(() => window.jiwei.plugins.list())).some((p) => p.id === `p2-race-${branch}@local`)).toBe(true)
    expect((await page.evaluate(() => window.jiwei.skills.list())).some((s) => s.name === `p2-race-${branch}:read`)).toBe(true)
    await expect.poll(() => previews()).toEqual([])
  })
}
