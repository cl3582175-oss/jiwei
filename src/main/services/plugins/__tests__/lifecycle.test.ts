import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile, rename, symlink } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getLoadablePath } from 'sqlite-vec'
import { eq } from 'drizzle-orm'
import * as schema from '../../../db/knowledgeSchema'
import type { McpServerInfo } from '@shared/agent'
import type { DB } from '../../../db'
const env = vi.hoisted(() => ({
  root: '',
  installGate: undefined as (() => Promise<void>) | undefined,
  db: null as DB | null,
  failAudit: false,
  journalFault: '' as '' | 'write' | 'publish',
  transport: {} as Record<string, unknown>,
  attach: undefined as (() => Promise<void>) | undefined,
  closed: 0,
  audits: [] as unknown[],
  call: undefined as (() => Promise<unknown>) | undefined
}))
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>()
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      if (env.journalFault === 'write' && String(args[0]).endsWith('/journal.tmp')) {
        await actual.writeFile(args[0], '{"id":')
        throw new Error('Injected journal write interruption')
      }
      return actual.writeFile(...args)
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (env.journalFault === 'publish' && String(args[0]).endsWith('/journal.tmp'))
        throw new Error('Injected journal publish interruption')
      if (String(args[1]).includes('/plugins/cache/')) await env.installGate?.()
      return actual.rename(...args)
    }
  }
})
vi.mock('electron', () => ({
  app: { getPath: () => env.root, getAppPath: () => env.root, getVersion: () => 'test', isPackaged: false },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() },
  net: { fetch: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
    decryptString: (value: Buffer) => value.toString().split('').reverse().join('')
  },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../../db', () => ({ getDb: () => env.db, getSqlite: () => null }))
vi.mock('../../settings', () => ({
  getSettings: () => ({ language: 'en', ai: { disabledSkills: [] }, browser: { aiBlockedSites: [] } }),
  setSettings: vi.fn()
}))
vi.mock('../../device', () => ({ deviceId: () => 'fixture-device' }))
vi.mock('../../memory', () => ({ skillPreferences: () => [] }))
vi.mock('../../agent/audit', () => ({
  audit: (entry: unknown) => {
    env.audits.push(entry)
    if (env.failAudit) throw new Error('Injected audit failure')
  }
}))
vi.mock('../../agent/wrap', async (original) => {
  const actual = await original<typeof import('../../agent/wrap')>()
  return { ...actual }
})
// 真实任务删除入口保留，隔离与本任务无关的 scheduler/AI/账号初始化。
vi.mock('../../tasks/scheduler', () => ({ clearTriggerState: vi.fn(), initializeTrigger: vi.fn() }))
vi.mock('../../ai/structured', () => ({ structured: vi.fn(), quickModel: vi.fn() }))
vi.mock('../../mail/accounts', () => ({ accountRow: vi.fn() }))
vi.mock('../../mcp/shellPath', () => ({ loginPath: async () => '/fixture/bin' }))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {
      await env.attach?.()
    }
    async listTools() {
      return { tools: [{ name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, openWorldHint: false } }] }
    }
    async callTool() {
      return env.call?.()
    }
    setNotificationHandler() {}
    async close() {
      env.closed++
    }
  }
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  getDefaultEnvironment: () => ({}),
  StdioClientTransport: class {
    constructor(input: Record<string, unknown>) {
      env.transport = input
    }
    async close() {
      env.closed++
    }
  }
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, input: Record<string, unknown>) {
      env.transport = { url: url.toString(), ...input }
    }
    async close() {
      env.closed++
    }
  }
}))
import {
  inspectPluginPath,
  inspectPlugin,
  registerPluginSourceAdapter,
  confirmPluginInstall,
  initializePlugins,
  updatePlugin,
  rollbackPlugin,
  setPluginEnabled,
  uninstallPlugin,
  setPluginConfig,
  listPlugins,
  cancelPluginPreview
} from '../install'
import { listTemplates, listFrameworks, listRecipes, replacePluginRegistry } from '../registry'
import { pluginCache, pluginData, pluginRoot, readState } from '../state'
import { listSkills, loadSkill, readSkillFile, skillCatalog, listLenses, saveLens, reloadSkills } from '../../ai/skills'
import { listServers, saveServer, connectServer, disconnect, pluginFetch, assistantMcpTools } from '../../mcp/client'
import { net } from 'electron'
import log from 'electron-log/main'
import { guardTools } from '../../agent/wrap'
import { enqueue, registerJobKind } from '../../jobs'

const serverInput = (s: McpServerInfo) => ({
  id: s.id,
  name: s.name,
  transport: s.transport,
  command: s.command ?? undefined,
  args: s.args,
  cwd: s.cwd,
  url: s.url ?? undefined
})
let db: Database.Database, root: string, source: string
async function file(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
async function fixture(version = 'one', extra: Record<string, unknown> = {}) {
  await file(
    join(source, '.claude-plugin/plugin.json'),
    JSON.stringify({
      name: 'sample',
      version,
      userConfig: { token: { type: 'string', title: 'Token', description: 'Synthetic', sensitive: true, required: true } },
      mcpServers: { sample: { command: 'fixture-never-executed', args: ['${user_config.token}'], env: { KEY: '${user_config.token}' } } },
      ...extra
    })
  )
  await file(join(source, 'skills/read/SKILL.md'), '---\nname: read\ndescription: Fixture reader\n---\nSelf authored fixture instruction.')
  await file(join(source, 'skills/read/never.sh'), 'touch SHOULD_NEVER_EXIST')
  await file(join(source, 'commands/check.md'), '---\ndescription: Fixture command\n---\nCheck $ARGUMENTS')
  await file(
    join(source, 'jiwei/templates/a.json'),
    JSON.stringify({
      id: 'a',
      type: 'article',
      title: { zh: '文', en: 'Article' },
      description: { zh: '文', en: 'Article' },
      outline: ['First', 'Second']
    })
  )
  await file(
    join(source, 'jiwei/frameworks/a.json'),
    JSON.stringify({
      id: 'a',
      title: { zh: '框', en: 'Frame' },
      description: { zh: '框', en: 'Frame' },
      criteria: [
        { name: 'a', weight: 1, hint: 'one' },
        { name: 'b', weight: 2, hint: 'two' }
      ],
      questions: []
    })
  )
  await file(
    join(source, 'jiwei/recipes/a.json'),
    JSON.stringify({
      id: 'a',
      name: { zh: '任务', en: 'Task' },
      instructionEn: 'Read',
      task: { name: 'Read', instruction: 'Read', trigger: { type: 'manual' }, tools: [], outputs: { inbox: true } }
    })
  )
  await file(
    join(source, 'jiwei/sources.json'),
    JSON.stringify({ feeds: [{ url: 'https://example.org/feed', title: 'Test feed', kind: 'rss' }] })
  )
}
async function install(config = {}) {
  const preview = await inspectPluginPath(source)
  return confirmPluginInstall(preview.token, { feeds: [0], config })
}
beforeEach(async () => {
  vi.useRealTimers()
  env.installGate = undefined
  env.failAudit = false
  env.journalFault = ''
  env.attach = undefined
  env.closed = 0
  env.audits = []
  env.call = undefined
  env.transport = {}
  root = await mkdtemp(join(tmpdir(), 'jiwei-p1b-'))
  env.root = join(root, 'user-data')
  source = join(root, 'source')
  await mkdir(env.root)
  db = new Database(join(env.root, 'test.db'))
  db.loadExtension(getLoadablePath())
  env.db = drizzle(db, { schema })
  migrate(env.db, { migrationsFolder: join(process.cwd(), 'resources/migrations') })
  await initializePlugins()
  reloadSkills()
  await fixture()
})
afterEach(async () => {
  for (const server of listServers()) await disconnect(server.id)
  for (const row of env.db!.select().from(schema.plugins).all()) replacePluginRegistry(row.id)
  await initializePlugins()
  db.close()
  env.db = null
  await rm(root, { recursive: true, force: true })
  vi.useRealTimers()
})
describe('production plugin lifecycle in isolated SQLite and filesystem', () => {
  it('installs every registry, only returns secret state, persists on restart and never executes scripts', async () => {
    const info = await install({ token: 'synthetic-secret-123' })
    expect(info.sensitive).toEqual({ token: true })
    expect(JSON.stringify(info)).not.toContain('synthetic-secret-123')
    const stored = env.db!.select().from(schema.plugins).get()!
    expect(stored.config).toBe('{}')
    expect(stored.secretsEnc!.toString()).not.toContain('synthetic-secret-123')
    expect(listServers()[0]).toMatchObject({ enabled: false, args: ['${user_config.token}'], pluginId: info.id })
    expect(listSkills().map((s) => s.name)).toEqual(['sample:check', 'sample:read'])
    expect(listSkills().find((s) => s.name === 'sample:read')?.hasScripts).toBe(true)
    expect(readSkillFile('sample:check', 'SKILL.md')).toContain('用户本次的要求')
    expect(loadSkill('sample:read', false)).toContain('<external-data')
    expect(skillCatalog('basic', false)).toContain('<external-data')
    expect(listTemplates()[0].id).toBe('sample:a')
    expect(listFrameworks()[0].id).toBe('sample:a')
    expect(listRecipes().find((r) => r.id === 'sample:a')?.task.recipe).toBe('sample:a')
    expect(listLenses()).toEqual([])
    await initializePlugins()
    expect(listPlugins()[0].version).toBe('one')
    expect(listSkills()).toHaveLength(2)
    expect(existsSync(join(process.cwd(), 'SHOULD_NEVER_EXIST'))).toBe(false)
    expect(env.db!.select().from(schema.jobs).all()).toHaveLength(0)
    for (const filename of await readdir(readState(info.id).current.directory, { recursive: true }))
      if (String(filename).endsWith('.json'))
        expect(await readFile(join(readState(info.id).current.directory, String(filename)), 'utf8')).not.toContain('synthetic-secret-123')
  })
  it('rejects invalid, reused and expired tokens; cancel removes the preview', async () => {
    await expect(confirmPluginInstall('0'.repeat(64), {})).rejects.toThrow('Invalid')
    const preview = await inspectPluginPath(source)
    await cancelPluginPreview(preview.token)
    await expect(confirmPluginInstall(preview.token, {})).rejects.toThrow('Invalid')
    const expired = await inspectPluginPath(source)
    const time = vi.spyOn(Date, 'now').mockReturnValue(expired.expiresAt + 1)
    await expect(confirmPluginInstall(expired.token, {})).rejects.toThrow('expired')
    time.mockRestore()
    const fresh = await inspectPluginPath(source)
    await confirmPluginInstall(fresh.token, {})
    await expect(confirmPluginInstall(fresh.token, {})).rejects.toThrow('Invalid')
    expect(await readdir(join(pluginRoot(), 'previews'))).toEqual([])
  })
  it('binds token to the main snapshot and detects snapshot changes', async () => {
    const preview = await inspectPluginPath(source)
    // 修改原文件不能替换已经确认的快照。
    await fixture('changed-original')
    expect((await confirmPluginInstall(preview.token, {})).version).toBe('one')
    const next = await updatePlugin('sample@local')
    const containers = await readdir(join(pluginRoot(), 'previews'))
    const paths = await readdir(join(pluginRoot(), 'previews', containers[0]), { recursive: true })
    const manifest = paths.map(String).find((p) => p.endsWith('.claude-plugin/plugin.json'))!
    await writeFile(join(pluginRoot(), 'previews', containers[0], manifest), JSON.stringify({ name: 'sample', version: 'tampered' }))
    await expect(confirmPluginInstall(next.token, {})).rejects.toThrow('changed after preview')
    expect(listPlugins()[0].version).toBe('one')
  })
  it('rolls back failed DB commits and permits fresh inspection without rows/files/jobs residue', async () => {
    const preview = await inspectPluginPath(source)
    env.failAudit = true
    await expect(confirmPluginInstall(preview.token, { feeds: [0] })).rejects.toThrow('Injected')
    env.installGate = undefined
    env.failAudit = false
    expect(env.db!.select().from(schema.plugins).all()).toEqual([])
    expect(env.db!.select().from(schema.mcpServers).all()).toEqual([])
    expect(env.db!.select().from(schema.feeds).all()).toEqual([])
    expect(env.db!.select().from(schema.jobs).all()).toEqual([])
    expect(existsSync(pluginCache('sample@local'))).toBe(false)
    expect(existsSync(pluginData('sample@local'))).toBe(false)
    expect((await install()).version).toBe('one')
  })
  it('requires fresh confirmation for added capabilities; rollback/disable/uninstall preserve user data', async () => {
    const info = await install()
    env
      .db!.insert(schema.aiTasks)
      .values({
        id: 'fixture-task',
        pluginId: info.id,
        name: 'User task',
        instruction: 'Keep',
        trigger: '{}',
        tools: '[]',
        outputs: '{}',
        createdAt: 1,
        updatedAt: 1,
        updatedBy: 'fixture-device'
      })
      .run()
    await fixture('two', { mcpServers: { remote: { type: 'http', url: 'https://new.example.org/mcp' } } })
    const next = await updatePlugin(info.id)
    expect(next.added.domains).toEqual(['new.example.org'])
    expect(listPlugins()[0].version).toBe('one')
    await confirmPluginInstall(next.token, {})
    expect(listPlugins()[0].version).toBe('two')
    await rollbackPlugin(info.id)
    expect(listPlugins()[0].version).toBe('one')
    expect(loadSkill('sample:read', false)).toContain('instruction')
    await setPluginEnabled(info.id, false)
    expect(listSkills()).toEqual([])
    expect(listTemplates()).toEqual([])
    expect(listFrameworks()).toEqual([])
    expect(listRecipes().some((r) => r.pluginId === info.id)).toBe(false)
    expect(() => loadSkill('sample:read', false)).toThrow()
    expect(() => readSkillFile('sample:read', 'never.sh')).toThrow()
    await setPluginEnabled(info.id, true)
    expect(listServers()[0].enabled).toBe(false)
    const abandonedUpdate = await updatePlugin(info.id)
    await uninstallPlugin(info.id)
    await expect(confirmPluginInstall(abandonedUpdate.token, {})).rejects.toThrow('Invalid')
    expect(await readdir(join(pluginRoot(), 'previews'))).toEqual([])
    expect(env.db!.select().from(schema.feeds).get()).toMatchObject({ pluginId: null, deletedAt: null, enabled: true })
    expect(env.db!.select().from(schema.aiTasks).get()).toMatchObject({ pluginId: null, deletedAt: null })
    expect(listServers()).toEqual([])
    expect(listPlugins()).toEqual([])
    expect(existsSync(pluginCache(info.id))).toBe(false)
    expect(existsSync(pluginData(info.id))).toBe(false)
  })
  it('restores uninstall on transaction failure and deletes selected feeds/tasks through services', async () => {
    const info = await install()
    const feed = env.db!.select().from(schema.feeds).get()!
    env
      .db!.insert(schema.aiTasks)
      .values({
        id: 'fixture-task',
        pluginId: info.id,
        name: 'User task',
        instruction: 'Keep',
        trigger: '{}',
        tools: '[]',
        outputs: '{}',
        createdAt: 1,
        updatedAt: 1,
        updatedBy: 'fixture-device'
      })
      .run()
    const feedJob = enqueue('discover.feed', { id: feed.id }, { runAfter: Date.now() + 3600000 }),
      taskJob = enqueue('ai.task', { taskId: 'fixture-task' }, { runAfter: Date.now() + 3600000 })
    env.failAudit = true
    await expect(uninstallPlugin(info.id)).rejects.toThrow('Injected')
    env.installGate = undefined
    env.failAudit = false
    expect(existsSync(readState(info.id).current.directory)).toBe(true)
    expect(listSkills()).toHaveLength(2)
    await uninstallPlugin(info.id, { removeFeeds: true, removeTasks: true })
    expect(env.db!.select().from(schema.feeds).get()?.deletedAt).toBeTruthy()
    expect(env.db!.select().from(schema.aiTasks).get()?.deletedAt).toBeTruthy()
    for (const id of [feedJob, taskJob])
      expect(env.db!.select().from(schema.jobs).where(eq(schema.jobs.id, id)).get()?.status).toBe('canceled')
  })
  it('does not abort an active user feed job when uninstall rolls back', async () => {
    const info = await install(),
      feed = env.db!.select().from(schema.feeds).get()!
    let release!: () => void,
      aborted = false
    registerJobKind('discover.feed', {
      title: () => 'Fixture',
      run: async (_payload, ctx) => {
        ctx.signal?.addEventListener('abort', () => {
          aborted = true
        })
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
    })
    const id = enqueue('discover.feed', { id: feed.id })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    env.failAudit = true
    await expect(uninstallPlugin(info.id, { removeFeeds: true })).rejects.toThrow('Injected')
    env.installGate = undefined
    env.failAudit = false
    expect(aborted).toBe(false)
    expect(env.db!.select().from(schema.jobs).where(eq(schema.jobs.id, id)).get()?.status).toBe('running')
    release()
    await vi.waitFor(() => expect(env.db!.select().from(schema.jobs).where(eq(schema.jobs.id, id)).get()?.status).toBe('done'))
    expect(listPlugins()[0].enabled).toBe(true)
  })
  it('recovers interrupted directory isolation and prunes only plugin-owned uncommitted versions', async () => {
    const info = await install(),
      current = readState(info.id).current.directory
    const trash = join(pluginRoot(), 'trash', 'interrupted')
    await mkdir(trash, { recursive: true })
    const moves = [
      { from: pluginCache(info.id), to: join(trash, '0') },
      { from: pluginData(info.id), to: join(trash, '1') }
    ]
    await writeFile(join(trash, 'journal.json'), JSON.stringify({ id: info.id, moves }))
    for (const move of moves) await rename(move.from, move.to)
    await initializePlugins()
    expect(existsSync(current)).toBe(true)
    await mkdir(join(pluginCache(info.id), 'uncommitted'))
    await initializePlugins()
    expect(await readdir(pluginCache(info.id))).toHaveLength(1)
    await rm(current, { recursive: true })
    await initializePlugins()
    expect(listPlugins()[0]).toMatchObject({ enabled: false, available: false })
    expect(listSkills()).toEqual([])
  })
  it.each(['market-a', 'market-b'])('rechecks namespace at confirm when %s wins', async (winner) => {
    registerPluginSourceAdapter(async (input) => {
      if (input.kind !== 'market') throw new Error('Fixture only supports market')
      return { path: source, type: 'folder', origin: { kind: 'market', market: input.market, locator: source, name: 'sample' } }
    })
    const a = await inspectPlugin({ kind: 'market', market: 'market-a', name: 'sample' })
    const b = await inspectPlugin({ kind: 'market', market: 'market-b', name: 'sample' })
    const [first, second] = winner === 'market-a' ? [a, b] : [b, a]
    await confirmPluginInstall(first.token, {})
    await expect(confirmPluginInstall(second.token, {})).rejects.toThrow('namespace')
    expect(listPlugins().map((p) => p.id)).toEqual([first.id])
    expect(listSkills().map((s) => s.name)).toEqual(['sample:check', 'sample:read'])
    expect(existsSync(pluginCache(second.id))).toBe(false)
    expect(existsSync(pluginData(second.id))).toBe(false)
  })
  it.each(['missing', 'empty', 'truncated', 'unpublished', 'unpublished-complete', 'invalid-schema', 'invalid-path', 'conflict'])(
    'preserves %s recovery evidence and continues valid journals',
    async (kind) => {
      const info = await install()
      const bad = join(pluginRoot(), 'trash', 'a-invalid')
      const good = join(pluginRoot(), 'trash', 'z-valid')
      await file(join(bad, '0/user.txt'), 'irreplaceable synthetic user data')
      if (kind === 'empty') await file(join(bad, 'journal.json'), '')
      if (kind === 'truncated') await file(join(bad, 'journal.json'), '{"id":')
      if (kind === 'unpublished') await file(join(bad, 'journal.tmp'), '{"id":')
      if (kind === 'unpublished-complete')
        await file(join(bad, 'journal.tmp'), JSON.stringify({ id: info.id, moves: [{ from: pluginData(info.id), to: join(bad, '0') }] }))
      if (kind === 'invalid-schema') await file(join(bad, 'journal.json'), JSON.stringify({ id: 42, moves: null }))
      if (kind === 'invalid-path')
        await file(join(bad, 'journal.json'), JSON.stringify({ id: 'absent@local', moves: [{ from: source, to: join(bad, '0') }] }))
      if (kind === 'conflict')
        await file(join(bad, 'journal.json'), JSON.stringify({ id: info.id, moves: [{ from: pluginData(info.id), to: join(bad, '0') }] }))
      const moves = [{ from: pluginCache(info.id), to: join(good, '0') }]
      await file(join(good, 'journal.json'), JSON.stringify({ id: info.id, moves }))
      await rename(moves[0].from, moves[0].to)
      await initializePlugins()
      expect(listPlugins()[0]).toMatchObject({ enabled: true, available: true })
      expect(listSkills()).toHaveLength(2)
      expect(existsSync(good)).toBe(false)
      const quarantine = join(pluginRoot(), 'quarantine')
      const entries = await readdir(quarantine)
      expect(entries).toHaveLength(1)
      expect(await readFile(join(quarantine, entries[0], '0/user.txt'), 'utf8')).toBe('irreplaceable synthetic user data')
      await initializePlugins()
      expect(await readdir(quarantine)).toEqual(entries)
    }
  )
  it.each(['write', 'publish'] as const)('keeps source directories intact when journal %s is interrupted', async (fault) => {
    const info = await install()
    await file(join(pluginData(info.id), 'user.txt'), 'synthetic user data')
    env.journalFault = fault
    await expect(uninstallPlugin(info.id)).rejects.toThrow('Injected journal')
    env.journalFault = ''
    expect(existsSync(readState(info.id).current.directory)).toBe(true)
    expect(await readFile(join(pluginData(info.id), 'user.txt'), 'utf8')).toBe('synthetic user data')
    const trashRoot = join(pluginRoot(), 'trash')
    const [entry] = await readdir(trashRoot)
    expect(await readdir(join(trashRoot, entry))).toEqual(['journal.tmp'])
    if (fault === 'publish') expect(JSON.parse(await readFile(join(trashRoot, entry, 'journal.tmp'), 'utf8')).moves).toHaveLength(2)
    await initializePlugins()
    expect(listPlugins()[0]).toMatchObject({ enabled: true, available: true })
    expect(await readdir(trashRoot)).toEqual([])
    expect(await readdir(join(pluginRoot(), 'quarantine'))).toHaveLength(1)
  })
  it.each([0, 1, 2])('recovers published removal after %i moves without data loss', async (count) => {
    const info = await install()
    await file(join(pluginData(info.id), 'user.txt'), 'synthetic user data')
    const trash = join(pluginRoot(), 'trash', 'published')
    const moves = [pluginCache(info.id), pluginData(info.id)].map((from, i) => ({ from, to: join(trash, String(i)) }))
    await file(join(trash, 'journal.json'), JSON.stringify({ id: info.id, moves }))
    for (const move of moves.slice(0, count)) await rename(move.from, move.to)
    await initializePlugins()
    expect(await readFile(join(pluginData(info.id), 'user.txt'), 'utf8')).toBe('synthetic user data')
    expect(listPlugins()[0]).toMatchObject({ enabled: true, available: true })
    expect(existsSync(trash)).toBe(false)
  })
  it('validates every recovery move before restoring any directory', async () => {
    const info = await install()
    const trash = join(pluginRoot(), 'trash', 'invalid-second-move')
    const moves = [
      { from: pluginCache(info.id), to: join(trash, '0') },
      { from: source, to: join(trash, '1') }
    ]
    await file(join(trash, 'journal.json'), JSON.stringify({ id: info.id, moves }))
    await rename(moves[0].from, moves[0].to)
    await file(join(trash, '1/user.txt'), 'preserve second move')
    await initializePlugins()
    expect(existsSync(pluginCache(info.id))).toBe(false)
    const [entry] = await readdir(join(pluginRoot(), 'quarantine'))
    const saved = join(pluginRoot(), 'quarantine', entry)
    expect(await readdir(join(saved, '0'))).toHaveLength(1)
    expect(await readFile(join(saved, '1/user.txt'), 'utf8')).toBe('preserve second move')
    expect(listPlugins()[0].enabled).toBe(false)
  })
  it('finishes committed removal from a valid published journal', async () => {
    const info = await install()
    const trash = join(pluginRoot(), 'trash', 'committed')
    const moves = [pluginCache(info.id), pluginData(info.id)].map((from, i) => ({ from, to: join(trash, String(i)) }))
    await file(join(trash, 'journal.json'), JSON.stringify({ id: info.id, moves }))
    for (const move of moves) await rename(move.from, move.to)
    env.db!.delete(schema.plugins).where(eq(schema.plugins.id, info.id)).run()
    replacePluginRegistry(info.id)
    await initializePlugins()
    expect(existsSync(trash)).toBe(false)
    expect(listPlugins()).toEqual([])
  })
  it('retains the original version/registry/MCP/config after failed update and rollback', async () => {
    const info = await install({ token: 'synthetic' }),
      state = readState(info.id)
    await fixture('two')
    const preview = await updatePlugin(info.id)
    env.failAudit = true
    await expect(confirmPluginInstall(preview.token, {})).rejects.toThrow('Injected')
    env.installGate = undefined
    env.failAudit = false
    expect(readState(info.id).current).toEqual(state.current)
    expect(listPlugins()[0].version).toBe('one')
    expect(listSkills()).toHaveLength(2)
    expect(await readdir(pluginCache(info.id))).toHaveLength(1)
    await confirmPluginInstall((await updatePlugin(info.id)).token, {})
    env.failAudit = true
    await expect(rollbackPlugin(info.id)).rejects.toThrow('Injected')
    env.installGate = undefined
    env.failAudit = false
    expect(listPlugins()[0]).toMatchObject({ version: 'two', sensitive: { token: true } })
    const a = await updatePlugin(info.id),
      b = await updatePlugin(info.id)
    await confirmPluginInstall(a.token, {})
    await expect(confirmPluginInstall(b.token, {})).rejects.toThrow('Installed plugin changed')
  })
  it('loads plugin lenses and safe user copies, preserving builtin/plugin/user precedence', async () => {
    await file(
      join(source, 'jiwei/lenses/view/SKILL.md'),
      '---\nname: view\ndescription: Fixture lens\nmetadata:\n  kind: lens\n  output: items\n  landing: append\n---\nReview evidence.'
    )
    const normal = (body: string) => `---\nname: read\ndescription: Fixture\n---\n${body}`
    await file(join(env.root, 'resources/skills/read/SKILL.md'), normal('builtin'))
    await file(join(env.root, 'skills/read/SKILL.md'), normal('user'))
    const info = await install()
    expect(loadSkill('read', false)).toContain('user')
    expect(loadSkill('sample:read', false)).toContain('<external-data')
    expect(listLenses()[0]).toMatchObject({ id: 'sample:view', source: 'plugin', pluginId: info.id })
    const copied = saveLens({ title: 'Copy', instruction: 'Copied fixture', copyFrom: 'sample:view' })
    expect(copied.id).toMatch(/^lens-/)
    expect(copied.source).toBe('user')
    await setPluginEnabled(info.id, false)
    expect(listLenses().map((l) => l.id)).toEqual([copied.id])
  })
  it('rejects concurrent mutations and blocks path escapes in bundled files', async () => {
    const preview = await inspectPluginPath(source)
    const first = confirmPluginInstall(preview.token, {})
    await expect(confirmPluginInstall(preview.token, {})).rejects.toThrow('in progress')
    await first
    const dir = readState('sample@local').current.directory
    await file(join(root, 'outside.txt'), 'outside')
    await symlink(join(root, 'outside.txt'), join(dir, 'skills/read/escape.txt'))
    expect(() => readSkillFile('sample:read', 'escape.txt')).toThrow('Unsafe')
    expect(() => readSkillFile('sample:read', '../../../../../outside.txt')).toThrow()
  })
})
describe('plugin MCP connection boundary', () => {
  it('requires configured values and prevents saveServer declaration bypass; substitutes only at connect', async () => {
    const info = await install()
    let server = listServers()[0]
    await expect(saveServer({ ...serverInput(server), enabled: true })).rejects.toThrow('Required')
    await setPluginConfig(info.id, { token: 'synthetic-secret-123' })
    await expect(saveServer({ ...serverInput(server), command: 'different' })).rejects.toThrow('updated plugin')
    await expect(saveServer({ ...serverInput(server), env: { KEY: 'unsafe' } })).rejects.toThrow('updated plugin')
    server = await saveServer({ ...serverInput(server), enabled: true })
    await connectServer(server.id)
    expect(env.transport.args).toEqual(['synthetic-secret-123'])
    expect((env.transport.env as Record<string, string>).KEY).toBe('synthetic-secret-123')
    expect(JSON.stringify(listServers())).not.toContain('synthetic-secret-123')
    expect(env.db!.select().from(schema.mcpServers).get()?.args).toBe('["${user_config.token}"]')
  })
  it('does not block an unrelated MCP server on another server’s required field', async () => {
    await fixture('one', {
      mcpServers: { secure: { command: 'fixture', args: ['${user_config.token}'] }, public: { command: 'fixture', args: [] } }
    })
    await install()
    const server = listServers().find((r) => r.name === 'public')!
    expect((await saveServer({ ...serverInput(server), enabled: true })).enabled).toBe(true)
    const secure = listServers().find((r) => r.name === 'secure')!
    await expect(saveServer({ ...serverInput(secure), enabled: true })).rejects.toThrow('Required')
  })
  it('blocks configuration after sensitive removal, and hides resolved secrets in failures', async () => {
    const info = await install({ token: 'synthetic-secret-123' }),
      server = listServers()[0]
    await saveServer({ ...serverInput(server), enabled: true })
    env.attach = async () => {
      throw new Error('synthetic-secret-123')
    }
    await expect(connectServer(server.id)).rejects.toThrow('Plugin connection failed')
    expect(JSON.stringify(listServers())).not.toContain('synthetic-secret-123')
    await setPluginConfig(info.id, { token: null })
    expect(listPlugins()[0].sensitive.token).toBe(false)
    expect(listServers()[0].enabled).toBe(false)
    await expect(saveServer({ ...serverInput(server), enabled: true })).rejects.toThrow('Required')
  })
  it.each(['rejection', 'isError'])('sanitizes connected plugin tool %s before guard logging and audit', async (kind) => {
    await install({ token: 'synthetic-secret-123' })
    const server = listServers()[0]
    await saveServer({ ...serverInput(server), enabled: true })
    await connectServer(server.id)
    env.call = async () => {
      if (kind === 'rejection') throw new Error('SDK args contained synthetic-secret-123')
      return { isError: true, content: [{ type: 'text', text: 'server echoed synthetic-secret-123' }] }
    }
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    try {
      const { tools, meta } = await assistantMcpTools(false)
      const guarded = guardTools(tools, meta, { zh: false, caller: 'fixture' })
      const execute = Object.values(guarded)[0].execute!
      const error = await Promise.resolve(execute({}, { toolCallId: 'fixture', messages: [], context: {} })).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('Plugin tool call failed')
      expect((error as Error).cause).toBeUndefined()
      expect(String(error)).not.toContain('synthetic-secret-123')
      expect(warn).toHaveBeenCalled()
      expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-secret-123')
      expect(env.audits).toContainEqual(
        expect.objectContaining({ status: 'error', detail: expect.stringContaining('Plugin tool call failed') })
      )
      expect(JSON.stringify(env.audits)).not.toContain('synthetic-secret-123')
    } finally {
      warn.mockRestore()
    }
  })
  it.each(['rejection', 'isError'])('preserves ordinary MCP tool %s details', async (kind) => {
    const server = await saveServer({ name: 'ordinary', transport: 'stdio', command: 'fixture-never-executed', enabled: true })
    await connectServer(server.id)
    const original = new Error('ordinary failure details')
    env.call = async () => {
      if (kind === 'rejection') throw original
      return { isError: true, content: [{ type: 'text', text: original.message }] }
    }
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
    try {
      const { tools, meta } = await assistantMcpTools(false)
      const guarded = guardTools(tools, meta, { zh: false, caller: 'fixture' })
      const error = await Promise.resolve(
        Object.values(guarded)[0].execute!({}, { toolCallId: 'fixture', messages: [], context: {} })
      ).catch((e: unknown) => e)
      expect((error as Error).message).toBe(original.message)
      if (kind === 'rejection') expect(error).toBe(original)
    } finally {
      warn.mockRestore()
    }
  })
  it('cannot revive an in-flight connection after plugin disable', async () => {
    const info = await install({ token: 'synthetic' }),
      server = listServers()[0]
    await saveServer({ ...serverInput(server), enabled: true })
    let release!: () => void
    env.attach = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    const connecting = connectServer(server.id)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await setPluginEnabled(info.id, false)
    release()
    await expect(connecting).rejects.toThrow('Plugin connection failed')
    expect(listServers()[0]).toMatchObject({ enabled: false, state: 'off' })
    expect(env.closed).toBeGreaterThan(0)
  })
  it('rejects undeclared HTTP domains including redirects before the second request', async () => {
    await fixture('one', { mcpServers: { remote: { type: 'http', url: 'https://allowed.example/mcp' } }, userConfig: {} })
    await install()
    const fetcher = pluginFetch('sample@local'),
      mocked = vi.mocked(net.fetch)
    mocked.mockReset()
    mocked.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/steal' } }))
    await expect(fetcher('https://allowed.example/mcp')).rejects.toThrow('not confirmed')
    expect(mocked).toHaveBeenCalledTimes(1)
    await expect(fetcher('https://elsewhere.example/steal')).rejects.toThrow('not confirmed')
    expect(mocked).toHaveBeenCalledTimes(1)
  })
})

describe('in-flight preview cancellation', () => {
  for (const update of [false, true])
    it(`cancels ${update ? 'update' : 'install'} before commit and restores the prior state`, async () => {
      if (update) {
        await install()
        await fixture('two')
      }
      const preview = update ? await updatePlugin('sample@local') : await inspectPluginPath(source)
      let release!: () => void, reached!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const ready = new Promise<void>((resolve) => {
        reached = resolve
      })
      env.installGate = async () => {
        reached()
        await gate
      }
      const result = confirmPluginInstall(preview.token, { feeds: [0], config: {} })
      const rejection = expect(result).rejects.toThrow('Plugin installation canceled')
      await ready
      await cancelPluginPreview(preview.token)
      release()
      await rejection
      env.installGate = undefined
      expect(listPlugins().map((p) => p.version)).toEqual(update ? ['one'] : [])
      expect(env.db!.select().from(schema.feeds).all()).toHaveLength(update ? 1 : 0)
      expect(env.db!.select().from(schema.mcpServers).all()).toHaveLength(update ? 1 : 0)
      if (update) expect((await readdir(pluginCache('sample@local'))).length).toBe(1)
      else expect(existsSync(pluginCache('sample@local'))).toBe(false)
      await expect(confirmPluginInstall(preview.token, {})).rejects.toThrow('already used')
    })
  it('reports committed installation unchanged when cancel arrives after commit', async () => {
    const preview = await inspectPluginPath(source)
    const installed = await confirmPluginInstall(preview.token, { feeds: [] })
    await cancelPluginPreview(preview.token)
    expect(listPlugins()[0].id).toBe(installed.id)
  })
})
