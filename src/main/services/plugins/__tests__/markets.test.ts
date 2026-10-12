import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { createServer, type Server } from 'http'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getLoadablePath } from 'sqlite-vec'
import JSZip from 'jszip'
import * as schema from '../../../db/knowledgeSchema'
import type { DB } from '../../../db'
const env = vi.hoisted(() => ({ root: '', db: null as DB | null, base: '', failAudit: false }))
vi.mock('electron', () => ({
  app: { getPath: () => join(env.root, 'data'), getAppPath: () => env.root, getVersion: () => 'test', isPackaged: false },
  net: { fetch: (url: string, options: RequestInit) => fetch(url.replace('https://archive.fixture', env.base), options) },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (v: Buffer) => v.toString()
  }
}))
vi.mock('../../../db', () => ({ getDb: () => env.db, getSqlite: () => null }))
vi.mock('../../settings', () => ({
  getSettings: () => ({ language: 'en', ai: { disabledSkills: [] }, browser: { aiBlockedSites: [] } }),
  setSettings: vi.fn()
}))
vi.mock('../../device', () => ({ deviceId: () => 'fixture-device' }))
vi.mock('../../memory', () => ({ skillPreferences: () => [] }))
vi.mock('../../agent/audit', () => ({
  audit: () => {
    if (env.failAudit) throw new Error('Injected audit failure')
  }
}))
vi.mock('../../tasks/scheduler', () => ({ clearTriggerState: vi.fn(), initializeTrigger: vi.fn() }))
vi.mock('../../ai/structured', () => ({ structured: vi.fn(), quickModel: vi.fn() }))
vi.mock('../../mail/accounts', () => ({ accountRow: vi.fn() }))
import {
  initializePlugins,
  inspectPlugin,
  confirmPluginInstall,
  updatePlugin,
  listPlugins,
  cancelPluginPreview,
  pluginDetails
} from '../install'
import {
  initializeMarkets,
  addMarket,
  addMarketSource,
  refreshMarkets,
  listMarkets,
  catalogPlugins,
  removeMarket,
  officialCatalog,
  comparePluginVersions
} from '../markets'
import {
  beginAcquisition,
  cancelAcquisition,
  detectGithub,
  detectPath,
  selectDetectedSkills,
  addDetectedMarket,
  cancelOwnerAcquisitions
} from '../direct'
import { AcquisitionBatch, githubSource } from '../acquisition'
import { prepareRepositorySource, preparePluginSource } from '../sources'
import { replacePluginRegistry } from '../registry'
import { readState } from '../state'
import { unicodePathZip } from './zipFixtures'
let db: Database.Database, server: Server
let routes: Map<string, { status?: number; body: string | Buffer; slow?: boolean }>, hits: string[]
const skill = '---\nname: read\ndescription: Self authored test reader\n---\nRead evidence.'
async function file(path: string, data: string | object) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, typeof data === 'string' ? data : JSON.stringify(data))
}
const entry = (name: string, source: unknown = `./plugins/${name}`, version = '1.0.0') => ({ name, source, version })
const market = (name: string, plugins: unknown[] = [entry('one')]) => ({ name, owner: { name: 'Self-authored fixture' }, plugins })
async function zip(files: Record<string, string | object>, prefix = 'repo/') {
  const z = new JSZip()
  for (const [name, value] of Object.entries(files)) z.file(prefix + name, typeof value === 'string' ? value : JSON.stringify(value))
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
async function repository(repo = 'owner/repo', manifest = market('test-market'), extra: Record<string, string | object> = {}) {
  routes.set(`/repos/${repo}`, { body: JSON.stringify({ default_branch: 'develop' }) })
  routes.set(`/repos/${repo}/commits/develop`, { body: 'a'.repeat(40) })
  routes.set(`/${repo}/develop/.claude-plugin/marketplace.json`, { body: JSON.stringify(manifest) })
  routes.set(`/${repo}/zip/${'a'.repeat(40)}`, {
    body: await zip({
      '.claude-plugin/marketplace.json': manifest,
      'plugins/one/.claude-plugin/plugin.json': { name: 'one', version: '1.0.0' },
      'plugins/one/skills/read/SKILL.md': skill,
      'plugins/one/README.md': '# Test\n<script>never()</script>\n[link](https://example.org)',
      ...extra
    })
  })
}
beforeEach(async () => {
  env.root = await mkdtemp(join(tmpdir(), 'jiwei-p2a-'))
  env.failAudit = false
  await mkdir(join(env.root, 'data'))
  db = new Database(join(env.root, 'data', 'test.db'))
  db.loadExtension(getLoadablePath())
  env.db = drizzle(db, { schema })
  migrate(env.db, { migrationsFolder: join(process.cwd(), 'resources/migrations') })
  routes = new Map()
  hits = []
  server = createServer((req, res) => {
    hits.push(req.url!)
    const route = routes.get(req.url!)
    res.statusCode = route?.status ?? (route ? 200 : 404)
    if (route?.slow) {
      res.write('x')
      const timer = setInterval(() => res.write('x'), 50)
      req.on('close', () => clearInterval(timer))
    } else res.end(route?.body ?? 'not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  env.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  for (const key of ['RAW', 'API', 'CODELOAD']) process.env[`JIWEI_GITHUB_${key}`] = env.base
  await file(join(env.root, 'resources/marketplace/.claude-plugin/marketplace.json'), market('jiwei', []))
  await initializePlugins()
  await initializeMarkets()
})
afterEach(async () => {
  await cancelOwnerAcquisitions(1)
  await cancelOwnerAcquisitions(2)
  for (const row of env.db!.select().from(schema.plugins).all()) replacePluginRegistry(row.id)
  await initializePlugins()
  db.close()
  env.db = null
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const key of ['RAW', 'API', 'CODELOAD']) delete process.env[`JIWEI_GITHUB_${key}`]
  await rm(env.root, { recursive: true, force: true })
})
describe('market acquisition through real HTTP, SQLite, files and token lifecycle', () => {
  it('caches a repository once per refresh, keeps last-good catalog on failure and uses stale/forced refresh', async () => {
    await repository('owner/repo', market('test-market', [entry('one'), entry('two', './plugins/two')]), {
      'plugins/two/.claude-plugin/plugin.json': { name: 'two', version: '2.0.0' },
      'plugins/two/skills/read/SKILL.md': skill,
      'unrelated/huge.md': 'x'.repeat(2 * 1024 * 1024)
    })
    await addMarket({ kind: 'github', url: 'owner/repo' })
    expect(catalogPlugins()).toHaveLength(2)
    expect(hits.filter((p) => p.includes('/zip/'))).toHaveLength(1)
    const fetchedAt = listMarkets().find((m) => m.name === 'test-market')!.fetchedAt
    hits = []
    await refreshMarkets(undefined, true)
    expect(hits).toEqual([])
    routes.delete('/owner/repo/develop/.claude-plugin/marketplace.json')
    await refreshMarkets('test-market')
    expect(listMarkets().find((m) => m.name === 'test-market')).toMatchObject({
      fetchedAt,
      count: 2,
      error: expect.stringContaining('cached')
    })
    expect(listMarkets().find((m) => m.name === 'jiwei')?.error).toBeNull()
  })
  it('installs from cached catalog, details sanitize HTML, retains content but denies update and stale confirmation after market removal', async () => {
    await repository()
    await addMarket({ kind: 'github', url: 'owner/repo' })
    const p = await inspectPlugin({ kind: 'market', market: 'test-market', name: 'one' })
    expect((await pluginDetails({ token: p.token })).readme).not.toContain('<script>')
    expect(p.origin.market).toBe('test-market')
    await confirmPluginInstall(p.token, {})
    const update = await updatePlugin(p.id)
    await removeMarket('test-market', { uninstall: false })
    expect(listPlugins()).toHaveLength(1)
    await expect(updatePlugin(p.id)).rejects.toThrow('removed')
    await expect(confirmPluginInstall(update.token, {})).rejects.toThrow('removed')
    await expect(readFile(join(readState(p.id).current.directory, 'skills/read/SKILL.md'), 'utf8')).resolves.toBe(skill)
  })
  it('rejects reserved/duplicate identities and cannot remove official market', async () => {
    const local = join(env.root, 'local')
    for (const name of ['jiwei', 'jiwei-official', 'JiWei-imposter']) {
      await file(join(local, '.claude-plugin/marketplace.json'), market(name, []))
      await expect(addMarketSource({ kind: 'folder', path: local })).rejects.toThrow('Reserved')
    }
    await file(join(local, '.claude-plugin/marketplace.json'), market('same', []))
    await addMarketSource({ kind: 'folder', path: local })
    await expect(addMarketSource({ kind: 'folder', path: local })).rejects.toThrow('already exists')
    await expect(removeMarket('jiwei', { uninstall: true })).rejects.toThrow('built-in')
  })
  it('removes market and all installed plugins atomically and restores directories when audit transaction fails', async () => {
    await repository('owner/repo', market('test-market', [entry('one'), entry('two')]), {
      'plugins/two/.claude-plugin/plugin.json': { name: 'two' },
      'plugins/two/skills/read/SKILL.md': skill
    })
    await addMarket({ kind: 'github', url: 'owner/repo' })
    for (const name of ['one', 'two']) {
      const p = await inspectPlugin({ kind: 'market', market: 'test-market', name })
      await confirmPluginInstall(p.token, {})
    }
    const directories = listPlugins().map((p) => readState(p.id).current.directory)
    env.failAudit = true
    await expect(removeMarket('test-market', { uninstall: true })).rejects.toThrow('audit failure')
    expect(listPlugins()).toHaveLength(2)
    expect(listMarkets()).toHaveLength(2)
    for (const dir of directories) expect(await readdir(dir)).toContain('skills')
    env.failAudit = false
    await removeMarket('test-market', { uninstall: true })
    expect(listPlugins()).toHaveLength(0)
    expect(listMarkets()).toHaveLength(1)
    expect(await readdir(join(env.root, 'data/plugins/trash'))).toEqual([])
  })
  it('selects official per-plugin newer remote or bundled version and falls back offline', async () => {
    const bundled = join(env.root, 'resources/marketplace')
    await file(
      join(bundled, '.claude-plugin/marketplace.json'),
      market('jiwei', [entry('one', './plugins/one', '2.0.0'), entry('two', './plugins/two', '3.0.0')])
    )
    for (const [name, version] of [
      ['one', '2.0.0'],
      ['two', '3.0.0']
    ]) {
      await file(join(bundled, `plugins/${name}/.claude-plugin/plugin.json`), { name, version })
      await file(join(bundled, `plugins/${name}/skills/read/SKILL.md`), skill)
    }
    await repository('official/repo', market('jiwei', [entry('one', './plugins/one', '4.0.0'), entry('two', './plugins/two', '1.0.0')]), {
      'plugins/one/.claude-plugin/plugin.json': { name: 'one', version: '4.0.0' },
      'plugins/two/.claude-plugin/plugin.json': { name: 'two', version: '1.0.0' }
    })
    let batch = new AcquisitionBatch(new AbortController().signal, 'test')
    try {
      const result = await officialCatalog(batch, { name: 'jiwei', bundled: 'resources/marketplace', remote: 'official/repo' })
      env
        .db!.update(schema.pluginMarkets)
        .set({ catalog: JSON.stringify(result.catalog) })
        .where(eq(schema.pluginMarkets.name, 'jiwei'))
        .run()
      expect(result.catalog.items.map((x) => [x.entry.name, x.version, x.source.kind])).toEqual([
        ['one', '4.0.0', 'github'],
        ['two', '3.0.0', 'folder']
      ])
    } finally {
      await batch.cleanup()
    }
    routes.clear()
    const offlinePreview = await inspectPlugin({ kind: 'market', market: 'jiwei', name: 'one' })
    expect(offlinePreview.version).toBe('2.0.0')
    await confirmPluginInstall(offlinePreview.token, {})
    batch = new AcquisitionBatch(new AbortController().signal, 'test')
    try {
      const result = await officialCatalog(batch, { name: 'jiwei', bundled: 'resources/marketplace', remote: 'official/repo' })
      expect(result.error).toContain('bundled')
      expect(result.catalog.items.every((x) => x.source.kind === 'folder')).toBe(true)
    } finally {
      await batch.cleanup()
    }
    expect(comparePluginVersions('1.0.0-beta.2', '1.0.0-beta.11')).toBe(-1)
    expect(comparePluginVersions('hash:abc', 'hash:def')).toBeNull()
  })
  it('uses discovered default branch; fallback main/master only on discovery failure; explicit bad ref never falls back', async () => {
    await repository()
    let batch = new AcquisitionBatch(new AbortController().signal, 'branches')
    try {
      await batch.catalog(githubSource('owner/repo'))
      expect(hits).toContain('/owner/repo/develop/.claude-plugin/marketplace.json')
      expect(hits.some((p) => p.includes('/main/'))).toBe(false)
    } finally {
      await batch.cleanup()
    }
    routes.delete('/repos/owner/repo')
    routes.set('/owner/repo/master/.claude-plugin/marketplace.json', { body: JSON.stringify(market('test-market', [])) })
    hits = []
    batch = new AcquisitionBatch(new AbortController().signal, 'fallback')
    try {
      await batch.catalog(githubSource('owner/repo'))
      expect(hits).toContain('/owner/repo/main/.claude-plugin/marketplace.json')
      expect(hits).toContain('/owner/repo/master/.claude-plugin/marketplace.json')
    } finally {
      await batch.cleanup()
    }
    hits = []
    batch = new AcquisitionBatch(new AbortController().signal, 'explicit')
    try {
      await expect(batch.catalog(githubSource('https://github.com/owner/repo/tree/missing'))).rejects.toThrow()
      expect(hits.every((p) => p.includes('/missing/'))).toBe(true)
    } finally {
      await batch.cleanup()
    }
  })
  it('supports relative/github/git-subdir/url/archive sources and denies npm/command/other git hosts', async () => {
    await repository(
      'owner/repo',
      market('source-market', [
        entry('one'),
        entry('two', { source: 'github', repo: 'owner/plugin', ref: 'main' }),
        entry('three', { source: 'git-subdir', url: 'owner/repo', path: 'plugins/three', ref: 'develop' }),
        entry('four', { source: 'url', url: 'https://github.com/owner/four' }),
        entry('five', { source: 'archive', url: 'https://archive.fixture/archive.zip' }),
        entry('npm', { source: 'npm', package: 'never' }),
        entry('command', { source: 'command', command: 'never' }),
        entry('other', { source: 'url', url: 'https://gitlab.com/owner/repo' })
      ]),
      {
        'plugins/three/.claude-plugin/plugin.json': { name: 'three' },
        'plugins/three/skills/read/SKILL.md': skill
      }
    )
    routes.set('/owner/plugin/zip/main', {
      body: await zip({ '.claude-plugin/plugin.json': { name: 'two' }, 'skills/read/SKILL.md': skill })
    })
    routes.set('/repos/owner/four', { body: JSON.stringify({ default_branch: 'main' }) })
    routes.set('/owner/four/zip/main', {
      body: await zip({ '.claude-plugin/plugin.json': { name: 'four' }, 'skills/read/SKILL.md': skill })
    })
    routes.set('/archive.zip', { body: await zip({ '.claude-plugin/plugin.json': { name: 'five' }, 'skills/read/SKILL.md': skill }, '') })
    await addMarket({ kind: 'github', url: 'owner/repo' })
    for (const name of ['one', 'two', 'three', 'four', 'five']) {
      const p = await inspectPlugin({ kind: 'market', market: 'source-market', name })
      expect(p.id).toBe(`${name}@source-market`)
      await cancelPluginPreview(p.token)
    }
    for (const name of ['npm', 'command', 'other']) {
      expect(catalogPlugins().find((p) => p.name === name)?.supported).toBe(false)
      await expect(inspectPlugin({ kind: 'market', market: 'source-market', name })).rejects.toThrow('Unsupported')
    }
  })
  it('projects strict:false selected skills before limits, rejecting unsafe unrelated raw archive entries', async () => {
    await repository('owner/repo', market('selection-market', [{ name: 'picked', source: './', strict: false, skills: ['./selected'] }]), {
      'selected/SKILL.md': skill.replace('name: read', 'name: selected'),
      'unselected/SKILL.md': skill.replace('name: read', 'name: unselected'),
      'unrelated/large.md': 'x'.repeat(2 * 1024 * 1024)
    })
    await addMarket({ kind: 'github', url: 'owner/repo' })
    const p = await inspectPlugin({ kind: 'market', market: 'selection-market', name: 'picked' })
    expect(p.skills).toHaveLength(1)
    await confirmPluginInstall(p.token, {})
    expect(await readdir(readState(p.id).current.directory)).toEqual(['selected'])
    const z = new JSZip()
    z.file('repo/plugin/SKILL.md', skill)
    z.file('repo/unrelated/link', 'target', { unixPermissions: 0o120777 })
    const path = join(env.root, 'unsafe.zip')
    await writeFile(path, await z.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }))
    await expect(prepareRepositorySource(path, 'plugin')).rejects.toThrow('symlink')
  })
  it('aborts an owned acquisition before any preview exists; wrong owner cannot cancel it; temporary downloads are cleaned', async () => {
    routes.set('/repos/owner/slow', { body: JSON.stringify({ default_branch: 'main' }) })
    routes.set('/owner/slow/zip/main', { body: '', slow: true })
    const before = (await readdir(tmpdir())).filter((x) => x.startsWith('jiwei-plugin-download-'))
    const id = beginAcquisition(1)
    const pending = detectGithub(1, id, { kind: 'github', url: 'owner/slow' })
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(hits).toContain('/owner/slow/zip/main'))
    await cancelAcquisition(2, id)
    await cancelAcquisition(1, id)
    await rejected
    expect(listPlugins()).toEqual([])
    // 系统临时目录是共享的：并行的其他测试文件可能正短暂占用同前缀目录，等它们清理完再比较
    await vi.waitFor(async () => expect((await readdir(tmpdir())).filter((x) => x.startsWith('jiwei-plugin-download-'))).toEqual(before), {
      timeout: 5000
    })
    expect(await readdir(join(env.root, 'data/plugins/previews')).catch(() => [])).toEqual([])
  })
  it('detects market/plugin/skills and only selected skills reach token install, with empty directories preserved', async () => {
    await repository()
    let id = beginAcquisition(1),
      detected = await detectGithub(1, id, { kind: 'github', url: 'owner/repo' })
    expect(detected.kind).toBe('market')
    if (detected.kind === 'market') await addDetectedMarket(1, id, detected.token)
    await cancelAcquisition(1, id)
    const local = join(env.root, 'collection')
    await file(join(local, 'first/SKILL.md'), skill.replace('name: read', 'name: first'))
    await file(join(local, 'second/SKILL.md'), skill.replace('name: read', 'name: second'))
    await file(join(local, 'second/never.py'), 'raise Exception()')
    id = beginAcquisition(1)
    detected = await detectPath(1, id, local)
    expect(detected.kind).toBe('skills')
    if (detected.kind !== 'skills') throw new Error('Expected skills')
    await expect(selectDetectedSkills(1, id, detected.token, ['../escape'])).rejects.toThrow('selection')
    const chosen = await selectDetectedSkills(1, id, detected.token, ['first'])
    if (chosen.kind !== 'plugin') throw new Error('Expected plugin preview')
    expect(chosen.preview.skills.map((s) => s.name)).toEqual(['collection:first'])
    expect(chosen.preview.scripts).toEqual([])
    await confirmPluginInstall(chosen.preview.token, {})
    expect(await readdir(readState(chosen.preview.id).current.directory)).toEqual(['first'])
    const empty = join(env.root, 'empty')
    await mkdir(join(empty, 'skills'), { recursive: true })
    const prepared = await preparePluginSource({ path: empty, type: 'folder' })
    try {
      expect(await readdir(prepared.root)).toEqual(['skills'])
    } finally {
      await prepared.cleanup()
    }
  })
  it('keeps cache with a rate-limit message and returns sha/content-hash versions from real direct plugin acquisition', async () => {
    await repository()
    await addMarket({ kind: 'github', url: 'owner/repo' })
    const initial = catalogPlugins()
    routes.set('/repos/owner/repo/commits/develop', { status: 429, body: 'rate limit fixture' })
    await refreshMarkets('test-market')
    expect(catalogPlugins()).toEqual(initial)
    expect(listMarkets().find((m) => m.name === 'test-market')!.error).toContain('rate limited')
    routes.set('/repos/owner/direct', { body: JSON.stringify({ default_branch: 'main' }) })
    routes.set('/repos/owner/direct/commits/main', { body: 'b'.repeat(40) })
    const content = await zip({ '.claude-plugin/plugin.json': { name: 'direct' }, 'skills/read/SKILL.md': skill })
    routes.set(`/owner/direct/zip/${'b'.repeat(40)}`, { body: content })
    let id = beginAcquisition(1)
    let detected = await detectGithub(1, id, { kind: 'github', url: 'owner/direct' })
    if (detected.kind !== 'plugin') throw new Error('Expected plugin')
    expect(detected.preview.version).toBe('b'.repeat(12))
    await cancelAcquisition(1, id)
    routes.delete('/repos/owner/direct/commits/main')
    routes.set('/owner/direct/zip/main', { body: content })
    id = beginAcquisition(1)
    detected = await detectGithub(1, id, { kind: 'github', url: 'owner/direct' })
    if (detected.kind !== 'plugin') throw new Error('Expected plugin')
    expect(detected.preview.version).toMatch(/^[a-f0-9]{12}$/)
    expect(detected.preview.version).not.toBe('b'.repeat(12))
    await cancelAcquisition(1, id)
  })
  it.each(['', 'repo-main/'])(
    'imports a %s zip marketplace snapshot, removes only its owned copy, and leaves the source zip intact',
    async (prefix) => {
      const path = join(env.root, 'source.zip')
      await writeFile(
        path,
        await zip({ '.claude-plugin/marketplace.json': market('zip-market', []), 'README.md': 'Self-authored' }, prefix)
      )
      const id = beginAcquisition(1),
        detected = await detectPath(1, id, path)
      if (detected.kind !== 'market') throw new Error('Expected market')
      await addDetectedMarket(1, id, detected.token)
      expect(await readdir(join(env.root, 'data/plugins/market-imports'))).toHaveLength(1)
      await removeMarket('zip-market', { uninstall: true })
      expect(await readdir(join(env.root, 'data/plugins/market-imports'))).toEqual([])
      expect((await readFile(path)).length).toBeGreaterThan(0)
    }
  )
  it('detects a GitHub Agent Skills collection and preserves selected content through two updates', async () => {
    routes.set('/repos/owner/collection', { body: JSON.stringify({ default_branch: 'main' }) })
    const content = await zip({
      'first/SKILL.md': skill.replace('name: read', 'name: first'),
      'second/SKILL.md': skill.replace('name: read', 'name: second'),
      'second/never.py': 'raise Exception()'
    })
    routes.set('/owner/collection/zip/main', { body: content })
    const id = beginAcquisition(1),
      detected = await detectGithub(1, id, { kind: 'github', url: 'owner/collection' })
    if (detected.kind !== 'skills') throw new Error('Expected GitHub skills')
    const chosen = await selectDetectedSkills(1, id, detected.token, ['first'])
    if (chosen.kind !== 'plugin') throw new Error('Expected preview')
    expect(chosen.preview.skills.map((x) => x.name)).toEqual(['collection:first'])
    await confirmPluginInstall(chosen.preview.token, {})
    for (let i = 0; i < 2; i++) {
      const update = await updatePlugin(chosen.preview.id)
      expect(update.skills.map((x) => x.name)).toEqual(['collection:first'])
      expect(update.scripts).toEqual([])
      await confirmPluginInstall(update.token, {})
      expect(await readdir(readState(chosen.preview.id).current.directory)).toEqual(['first'])
    }
  })
  it.each(['folder', 'zip'])(
    'I1 discovers %s markets under repository budgets and only installs the selected small plugin',
    async (kind) => {
      const files = {
        '.claude-plugin/marketplace.json': market('large-local'),
        'plugins/one/.claude-plugin/plugin.json': { name: 'one' },
        'plugins/one/skills/read/SKILL.md': skill,
        'unrelated/large.md': 'x'.repeat(2 * 1024 * 1024)
      }
      const path = join(env.root, kind === 'zip' ? 'large.zip' : 'large')
      if (kind === 'zip') await writeFile(path, await zip(files, ''))
      else for (const [name, value] of Object.entries(files)) await file(join(path, name), value)
      const id = beginAcquisition(1),
        detected = await detectPath(1, id, path)
      if (detected.kind !== 'market') throw new Error('Expected market')
      await addDetectedMarket(1, id, detected.token)
      const preview = await inspectPlugin({ kind: 'market', market: 'large-local', name: 'one' })
      await confirmPluginInstall(preview.token, {})
      expect(await readdir(readState(preview.id).current.directory)).toEqual(['.claude-plugin', 'skills'])
      await cancelAcquisition(1, id)
      if (kind === 'folder') await symlink(join(path, 'plugins'), join(path, 'unrelated/link'))
      else {
        const z = new JSZip()
        z.file('plugin/ok', 'ok')
        z.file('unrelated/link', 'target', { unixPermissions: 0o120777 })
        await writeFile(path, await z.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }))
      }
      await expect(detectPath(1, beginAcquisition(1), path)).rejects.toThrow('symlink')
    }
  )
  it.each(['folder', 'zip'])('I1 selects one skill from a %s collection with unselected oversized text', async (kind) => {
    const files = {
      'first/SKILL.md': skill.replace('name: read', 'name: first'),
      'second/SKILL.md': skill.replace('name: read', 'name: second'),
      'second/large.md': 'x'.repeat(2 * 1024 * 1024)
    }
    const path = join(env.root, kind === 'zip' ? 'collection.zip' : 'collection')
    if (kind === 'zip') await writeFile(path, await zip(files, ''))
    else for (const [name, value] of Object.entries(files)) await file(join(path, name), value)
    const id = beginAcquisition(1),
      detected = await detectPath(1, id, path)
    if (detected.kind !== 'skills') throw new Error('Expected skills')
    const chosen = await selectDetectedSkills(1, id, detected.token, ['first'])
    if (chosen.kind !== 'plugin') throw new Error('Expected plugin')
    await confirmPluginInstall(chosen.preview.token, {})
    expect(await readdir(readState(chosen.preview.id).current.directory)).toEqual(['first'])
  })
  it.each(['folder', 'zip'])('I2 uses manifest identities before arbitrary %s names and derives stable collection names', async (kind) => {
    const path = join(env.root, kind === 'zip' ? 'My Plugin (1).zip' : 'My Plugin (1)')
    const files = { '.claude-plugin/plugin.json': { name: 'formal-name' }, 'skills/read/SKILL.md': skill }
    if (kind === 'zip') await writeFile(path, await zip(files, ''))
    else for (const [name, value] of Object.entries(files)) await file(join(path, name), value)
    let id = beginAcquisition(1),
      detected = await detectPath(1, id, path)
    if (detected.kind !== 'plugin') throw new Error('Expected plugin')
    expect(detected.preview.id).toBe('formal-name@local')
    await cancelAcquisition(1, id)
    if (kind === 'zip') await writeFile(path, await zip({ '.claude-plugin/marketplace.json': market('formal-market', []) }, ''))
    else {
      await rm(path, { recursive: true })
      await file(join(path, '.claude-plugin/marketplace.json'), market('formal-market', []))
    }
    id = beginAcquisition(1)
    detected = await detectPath(1, id, path)
    expect(detected).toMatchObject({ kind: 'market', name: 'formal-market' })
    await cancelAcquisition(1, id)
    if (kind === 'zip') await writeFile(path, await zip({ 'first/SKILL.md': skill.replace('name: read', 'name: first') }, ''))
    else {
      await rm(path, { recursive: true })
      await file(join(path, 'first/SKILL.md'), skill.replace('name: read', 'name: first'))
    }
    id = beginAcquisition(1)
    detected = await detectPath(1, id, path)
    if (detected.kind !== 'skills') throw new Error('Expected skills')
    expect(detected.name).toMatch(/^[a-zA-Z0-9_-]+$/)
    const name = detected.name
    await cancelAcquisition(1, id)
    expect(await detectPath(1, beginAcquisition(1), path)).toMatchObject({ kind: 'skills', name })
  })
  it('I2 accepts a GitHub subdirectory with spaces when it has a manifest', async () => {
    routes.set('/owner/repo/zip/main', {
      body: await zip({ 'My Plugin/.claude-plugin/plugin.json': { name: 'formal-name' }, 'My Plugin/skills/read/SKILL.md': skill })
    })
    const detected = await detectGithub(1, beginAcquisition(1), {
      kind: 'github',
      url: 'https://github.com/owner/repo/tree/main/My%20Plugin'
    })
    if (detected.kind !== 'plugin') throw new Error('Expected plugin')
    expect(detected.preview.id).toBe('formal-name@local')
  })
  it.each(['500', 'corrupt'])('I3 retains last-good metadata/time when raw succeeds but archive is %s, then recovers', async (failure) => {
    const manifest = market('test-market', [{ name: 'one', source: './plugins/one' }])
    await repository('owner/repo', manifest)
    await addMarket({ kind: 'github', url: 'owner/repo' })
    const installed = await inspectPlugin({ kind: 'market', market: 'test-market', name: 'one' })
    await confirmPluginInstall(installed.token, {})
    await repository('owner/repo', manifest, {
      'plugins/one/.claude-plugin/plugin.json': { name: 'one', version: '2.0.0', description: 'Known metadata' },
      'plugins/one/jiwei/manifest.json': { schema: 1, category: 'role', name: { zh: '角色', en: 'Role' } }
    })
    await refreshMarkets('test-market')
    const old = catalogPlugins(),
      row = listMarkets().find((m) => m.name === 'test-market')!
    expect(old[0]).toMatchObject({ version: '2.0.0', installedVersion: '1.0.0', updateAvailable: true, category: 'role' })
    const healthy = join(env.root, 'healthy')
    await file(join(healthy, '.claude-plugin/marketplace.json'), market('healthy', []))
    await addMarketSource({ kind: 'folder', path: healthy })
    routes.set(`/owner/repo/zip/${'a'.repeat(40)}`, failure === '500' ? { status: 500, body: 'down' } : { body: 'broken zip' })
    await refreshMarkets()
    expect(catalogPlugins()).toEqual(old)
    expect(listMarkets().find((m) => m.name === 'test-market')).toMatchObject({ fetchedAt: row.fetchedAt, error: expect.any(String) })
    expect(listMarkets().find((m) => m.name === 'healthy')!.error).toBeNull()
    await repository('owner/repo', manifest, {
      'plugins/one/.claude-plugin/plugin.json': { name: 'one', version: '3.0.0', description: 'Recovered metadata' }
    })
    await refreshMarkets('test-market')
    expect(listMarkets().find((m) => m.name === 'test-market')!.error).toBeNull()
    expect(catalogPlugins()[0]).toMatchObject({
      version: '3.0.0',
      description: 'Recovered metadata',
      installedVersion: '1.0.0',
      updateAvailable: true
    })
  })
  it('I4 updates a wrapped local plugin zip from its persisted selected root', async () => {
    const path = join(env.root, 'wrapped.zip')
    const write = (version: string) =>
      zip({ '.claude-plugin/plugin.json': { name: 'wrapped', version }, 'skills/read/SKILL.md': skill }).then((buffer) =>
        writeFile(path, buffer)
      )
    await write('1.0.0')
    const detected = await detectPath(1, beginAcquisition(1), path)
    if (detected.kind !== 'plugin') throw new Error('Expected plugin')
    await confirmPluginInstall(detected.preview.token, {})
    await write('2.0.0')
    const updated = await updatePlugin(detected.preview.id)
    expect(updated.version).toBe('2.0.0')
    expect(updated.skills).toHaveLength(1)
    await confirmPluginInstall(updated.token, {})
  })
  it.each(['', 'repo-main/'])(
    'I4 preserves skill projection on two updates of a %s local zip, retaining old state after unsafe failure',
    async (prefix) => {
      const path = join(env.root, 'collection.zip')
      await writeFile(
        path,
        await zip(
          {
            'first/SKILL.md': skill.replace('name: read', 'name: first'),
            'second/SKILL.md': skill.replace('name: read', 'name: second'),
            'second/never.py': 'raise Exception()'
          },
          prefix
        )
      )
      const id = beginAcquisition(1),
        detected = await detectPath(1, id, path)
      if (detected.kind !== 'skills') throw new Error('Expected skills')
      const chosen = await selectDetectedSkills(1, id, detected.token, ['first'])
      if (chosen.kind !== 'plugin') throw new Error('Expected preview')
      await confirmPluginInstall(chosen.preview.token, {})
      for (let i = 0; i < 2; i++) {
        const updated = await updatePlugin(chosen.preview.id)
        expect(updated.scripts).toEqual([])
        expect(updated.skills.map((x) => x.name)).toEqual([`${detected.name}:first`])
        await confirmPluginInstall(updated.token, {})
        expect(await readdir(readState(chosen.preview.id).current.directory)).toEqual(['first'])
      }
      const old = readState(chosen.preview.id).current
      await writeFile(path, 'broken zip')
      await expect(updatePlugin(chosen.preview.id)).rejects.toThrow()
      expect(readState(chosen.preview.id).current).toEqual(old)
      expect(await readFile(join(old.directory, 'first/SKILL.md'), 'utf8')).toContain('name: first')
    }
  )
  it('I5 preserves source-checked official remote cache/time across initialization and stale refresh, merging newer bundled', async () => {
    const definition = { name: 'jiwei', bundled: 'resources/marketplace', remote: 'official/repo' }
    const initialize = initializeMarkets as (override?: typeof definition) => Promise<void>
    await repository('official/repo', market('jiwei'), { 'plugins/one/.claude-plugin/plugin.json': { name: 'one', version: '3.0.0' } })
    await initialize(definition)
    await refreshMarkets('jiwei')
    expect(catalogPlugins().find((p) => p.id === 'one@jiwei')?.version).toBe('3.0.0')
    const oldTime = Date.now() - 86_400_001
    env.db!.update(schema.pluginMarkets).set({ fetchedAt: oldTime }).where(eq(schema.pluginMarkets.name, 'jiwei')).run()
    hits = []
    await initialize(definition)
    expect(hits).toEqual([])
    expect(listMarkets()[0].fetchedAt).toBe(oldTime)
    expect(catalogPlugins()[0].version).toBe('3.0.0')
    await refreshMarkets('jiwei', true)
    expect(hits).toContain('/official/repo/develop/.claude-plugin/marketplace.json')
    const fetched = listMarkets()[0].fetchedAt
    routes.clear()
    await initialize(definition)
    await refreshMarkets('jiwei')
    expect(catalogPlugins()[0].version).toBe('3.0.0')
    expect(listMarkets()[0].fetchedAt).toBe(fetched)
    expect(listMarkets()[0].error).not.toBeNull()
    await file(join(env.root, 'resources/marketplace/.claude-plugin/marketplace.json'), market('jiwei'))
    await file(join(env.root, 'resources/marketplace/plugins/one/.claude-plugin/plugin.json'), { name: 'one', version: '4.0.0' })
    await file(join(env.root, 'resources/marketplace/plugins/one/skills/read/SKILL.md'), skill)
    await initialize(definition)
    expect(catalogPlugins()[0].version).toBe('4.0.0')
    expect(listMarkets()[0].fetchedAt).toBe(fetched)
    await initialize({ ...definition, remote: 'different/repo' })
    expect(listMarkets()[0].fetchedAt).toBeNull()
  })
  it.each(['selected', 'unselected'])('R1-I1 rejects unsafe Unicode paths in %s repository entries before selection', async (location) => {
    const path = join(env.root, 'unicode-repository.zip')
    await writeFile(
      path,
      unicodePathZip([
        { name: 'repo/selected/keep.txt' },
        { name: 'repo/safe.txt', unicodeName: `repo/${location}/../${location}/evil.txt` }
      ])
    )
    const attempt = prepareRepositorySource(path, '.', undefined, ['selected']).then(async (prepared) => {
      await prepared.cleanup()
      return 'accepted'
    })
    await expect(attempt).rejects.toThrow('Unsafe plugin path')
  })
  it.each(['first', 'unselected'])(
    'R1-I1 rejects %s Unicode paths during local detection/update and retains the installed selection',
    async (location) => {
      const path = join(env.root, 'collection.zip')
      await writeFile(path, await zip({ 'first/SKILL.md': skill.replace('name: read', 'name: first') }, ''))
      const operation = beginAcquisition(1),
        detected = await detectPath(1, operation, path)
      if (detected.kind !== 'skills') throw new Error('Expected skills')
      const selected = await selectDetectedSkills(1, operation, detected.token, ['first'])
      if (selected.kind !== 'plugin') throw new Error('Expected plugin')
      await confirmPluginInstall(selected.preview.token, {})
      const previous = readState(selected.preview.id).current
      await writeFile(
        path,
        unicodePathZip([
          { name: 'first/SKILL.md', content: skill.replace('name: read', 'name: first') },
          { name: 'safe.txt', unicodeName: `../${location}/evil.txt` }
        ])
      )
      await expect(updatePlugin(selected.preview.id)).rejects.toThrow('Unsafe plugin path')
      expect(readState(selected.preview.id).current).toEqual(previous)
      expect(await readdir(previous.directory)).toEqual(['first'])
      await expect(detectPath(1, beginAcquisition(1), path)).rejects.toThrow('Unsafe plugin path')
    }
  )
})
