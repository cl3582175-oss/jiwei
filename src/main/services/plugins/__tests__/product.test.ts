import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import Database from 'better-sqlite3'
import { createServer } from 'http'
import JSZip from 'jszip'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getLoadablePath } from 'sqlite-vec'
import * as schema from '../../../db/knowledgeSchema'
import type { DB } from '../../../db'
const env = vi.hoisted(() => ({
  root: '',
  db: null as DB | null,
  calls: [] as { system: string; prompt: string; purpose: string }[],
  failure: false,
  advisorGate: undefined as Promise<void> | undefined,
  onAudit: undefined as ((entry: { summary: string }) => void) | undefined,
  toolGate: undefined as (() => Promise<void>) | undefined
}))
vi.mock('electron', () => ({
  app: { getPath: () => env.root, getAppPath: () => process.cwd(), getVersion: () => 'test', isPackaged: false },
  dialog: {},
  shell: {},
  net: {
    fetch: (url: string, options: RequestInit) => {
      if (!url.startsWith('http://127.0.0.1:')) throw new Error('Unexpected network request in isolated test')
      return fetch(url, options)
    }
  },
  safeStorage: {},
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../../db', () => ({
  getDb: () => env.db,
  getSqlite: () => (env.db as { $client?: unknown } | null)?.$client ?? null
}))
vi.mock('../../../lib/messages', () => ({ tr: (_zh: string, en: string) => en }))
vi.mock('../../settings', () => ({
  getSettings: () => ({
    language: 'en',
    ai: { disabledSkills: [], chat: { providerId: 'controlled', model: 'controlled' } },
    tasks: { paused: true },
    browser: { aiBlockedSites: [] }
  }),
  setSettings: vi.fn()
}))
vi.mock('../../device', () => ({ deviceId: () => 'fixture' }))
vi.mock('../../memory', () => ({ skillPreferences: () => [], getMeta: vi.fn(), setMeta: vi.fn() }))
vi.mock('../../agent/audit', () => ({ audit: (entry: { summary: string }) => env.onAudit?.(entry) }))
vi.mock('../../agent/usage', () => ({ checkBudget: vi.fn(), perRunLimit: () => 1 }))
vi.mock('../../agent/context', () => ({ withRun: async (_: unknown, fn: () => Promise<unknown>) => fn() }))
vi.mock('../../ai/retrieve', () => ({ retrieve: async () => [] }))
vi.mock('../../tasks/scheduler', () => ({ initializeTrigger: vi.fn(), clearTriggerState: vi.fn() }))
vi.mock('../../tasks/tools', () => ({
  taskToolCatalog: async () => {
    await env.toolGate?.()
    return { tools: { knowledge_search: {} }, info: [] }
  }
}))
vi.mock('../../mail/accounts', () => ({ accountRow: vi.fn() }))
vi.mock('../../mcp/client', () => ({ disconnect: vi.fn(), connectServer: vi.fn(), listServers: () => [] }))
vi.mock('../../discover/localSpeech', () => ({ localSpeechReady: () => false }))
vi.mock('../../discover/tts', () => ({ ttsProviders: () => [] }))
vi.mock('../../notes', () => ({ createNote: vi.fn(), getNote: vi.fn() }))
vi.mock('../../proposals', () => ({ createProposal: vi.fn() }))
vi.mock('../../ai/structured', () => ({
  quickModel: () => 'controlled',
  structured: async (input: { system: string; prompt: string; purpose: string }) => {
    env.calls.push(input)
    if (input.purpose === 'advisor.memo') await env.advisorGate
    if (env.failure) throw new Error('Controlled provider unavailable')
    if (input.purpose.startsWith('works.'))
      return {
        sections: [
          { title: 'First', points: ['Point'], sources: [] },
          { title: 'Second', points: ['Point'], sources: [] }
        ]
      }
    return {
      restated: 'Controlled question',
      options: [
        { id: 'O1', title: 'One', summary: 'First' },
        { id: 'O2', title: 'Two', summary: 'Second' }
      ],
      criteria: [
        { name: 'Evidence', weight: 5, why: 'Controlled' },
        { name: 'Cost', weight: 2, why: 'Controlled' }
      ],
      scores: [],
      evidence: [],
      assumptions: [],
      premortem: [],
      secondOrder: [],
      counter: '',
      risks: [],
      recommendation: { option: 'O1', why: 'Controlled' },
      confidence: 2,
      unknowns: []
    }
  }
}))
import { updatePlugin, inspectPluginPath, confirmPluginInstall, setPluginEnabled, uninstallPlugin, initializePlugins } from '../install'
import { replacePluginRegistry, listTemplates, listFrameworks, listRecipes, listStarters } from '../registry'
import { createWork, generateOutline, getWork, updateWork } from '../../works'
import { ask, cancelGeneration, runningGenerations, getDecision, listDecisions, regenerate, setWeights } from '../../advisor'
import { recipes, saveTask } from '../../tasks/service'
import { initializeMarkets, addMarket } from '../markets'
import {
  beginRoleSelection,
  previewRoles,
  confirmRoles,
  cancelRoleSelection,
  cancelOwnerRoleSelections,
  roleCatalog,
  roleRecovery
} from '../roles'
import { TaskSave } from '@shared/tasks'
import { listRoleStarters, completeRoleStarter, dismissRoleStarters } from '../starters'

// 解包上限与真实安装流程较重；机器忙时 5 秒默认超时会误报
vi.setConfig({ testTimeout: 20_000 })
let db: Database.Database, root: string, source: string
async function file(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jiwei-product-'))
  env.root = join(root, 'user')
  await mkdir(env.root)
  source = join(root, 'source')
  db = new Database(join(env.root, 'test.db'))
  db.loadExtension(getLoadablePath())
  env.db = drizzle(db, { schema })
  migrate(env.db, { migrationsFolder: join(process.cwd(), 'resources/migrations') })
  env.calls = []
  env.failure = false
  env.advisorGate = undefined
  env.onAudit = undefined
  env.toolGate = undefined
  await file(join(source, '.claude-plugin/plugin.json'), { name: 'product', version: '1' })
  await file(join(source, 'jiwei/templates/a.json'), {
    id: 'a',
    type: 'article',
    title: { zh: '保留标题', en: 'Retained title' },
    description: { zh: '描述', en: 'Description' },
    audience: 'Beginners',
    mode: 'coach',
    outline: ['Evidence first', 'Next steps'],
    guidance: 'UNTRUSTED_TEMPLATE_MARKER'
  })
  await file(join(source, 'jiwei/frameworks/a.json'), {
    id: 'a',
    title: { zh: '决策', en: 'Decision' },
    description: { zh: '描述', en: 'Description' },
    criteria: [
      { name: 'Evidence', weight: 5, hint: 'UNTRUSTED_FRAMEWORK_MARKER' },
      { name: 'Cost', weight: 2, hint: 'Check cost' }
    ],
    questions: ['What evidence is missing?']
  })
  await file(join(source, 'jiwei/recipes/a.json'), {
    id: 'a',
    name: { zh: '任务', en: 'Recipe' },
    instructionEn: 'Review actual evidence',
    task: { name: '任务', instruction: '复核证据', trigger: { type: 'manual' }, tools: ['knowledge_search'], outputs: { inbox: true } }
  })
  const preview = await inspectPluginPath(source)
  await confirmPluginInstall(preview.token, { feeds: [], config: {} })
})
afterEach(async () => {
  replacePluginRegistry('product@local')
  for (const role of ['school', 'research', 'kaoyan', 'jobseeker', 'product', 'teacher', 'creator', 'manager']) {
    replacePluginRegistry(`role-${role}@local`)
    replacePluginRegistry(`role-${role}@jiwei`)
  }
  env.onAudit = undefined
  await cancelOwnerRoleSelections(7)
  await cancelOwnerRoleSelections(8)
  vi.restoreAllMocks()
  db.close()
  env.db = null
  await rm(root, { recursive: true, force: true })
})
describe('plugin selections enter persisted product paths', () => {
  it('keeps authored roles optional, then projects all confirmed contributions and removes them on disable', async () => {
    expect(listStarters()).toEqual([])
    expect(
      env
        .db!.select()
        .from(schema.plugins)
        .all()
        .some((p) => p.id.startsWith('role-'))
    ).toBe(false)
    const roleIds = ['school', 'research', 'kaoyan', 'jobseeker', 'product', 'teacher', 'creator', 'manager']
    for (const role of roleIds) {
      const preview = await inspectPluginPath(join(process.cwd(), 'resources/marketplace/plugins', `role-${role}`))
      expect(preview.issues).toEqual([])
      expect(preview.starters).toHaveLength(3)
      expect(preview.templates).toHaveLength(3)
      expect(preview.skills.filter((s) => s.kind === 'lens')).toHaveLength(role === 'product' ? 2 : 1)
      expect(preview.recipes).toHaveLength(['creator', 'jobseeker'].includes(role) ? 1 : 2)
      // 预览不改变安装、任务和起步卡状态；显式确认才注册。
      expect(listStarters().some((s) => s.pluginId === preview.id)).toBe(false)
      await confirmPluginInstall(preview.token, { feeds: [], config: {} })
      expect(listStarters().filter((s) => s.pluginId === preview.id)).toHaveLength(3)
    }
    expect(listTemplates().filter((t) => t.pluginId?.startsWith('role-'))).toHaveLength(24)
    expect(listFrameworks().filter((f) => f.pluginId?.startsWith('role-'))).toHaveLength(10)
    expect(listRecipes().filter((r) => r.pluginId?.startsWith('role-'))).toHaveLength(14)
    expect(listStarters()).toHaveLength(24)
    expect(env.db!.select().from(schema.aiTasks).all()).toEqual([])
    const start = listStarters().find((s) => s.id === 'role-kaoyan:first-school-choice')!
    expect(start.action).toMatchObject({ kind: 'advisor', framework: 'role-kaoyan:kaoyan-school-choice' })
    for (const role of roleIds) await setPluginEnabled(`role-${role}@local`, false)
    expect(listStarters()).toEqual([])
    expect(listTemplates().filter((t) => t.pluginId?.startsWith('role-'))).toEqual([])
    expect(listFrameworks().filter((f) => f.pluginId?.startsWith('role-'))).toEqual([])
    expect(listRecipes().filter((r) => r.pluginId?.startsWith('role-'))).toEqual([])
  })

  it('persists role completion and dismissal through reload, disables without resetting and resets only on uninstall', async () => {
    const preview = await inspectPluginPath(join(process.cwd(), 'resources/marketplace/plugins/role-kaoyan'))
    await confirmPluginInstall(preview.token, {})
    const id = 'role-kaoyan@local'
    expect(listRoleStarters().map((r) => r.pluginId)).toEqual([id])
    const first = listRoleStarters()[0].starters[0]
    expect(first.completed).toBe(false)
    expect(completeRoleStarter(id, first.id)).toEqual(first.action)
    expect(listRoleStarters()[0].starters[0].completed).toBe(true)
    replacePluginRegistry(id)
    await initializePlugins()
    expect(listRoleStarters()[0].starters[0].completed).toBe(true)
    await setPluginEnabled(id, false)
    expect(listRoleStarters()).toEqual([])
    expect(() => completeRoleStarter(id, first.id)).toThrow('Role unavailable')
    await setPluginEnabled(id, true)
    expect(listRoleStarters()[0].starters[0].completed).toBe(true)
    expect(() => completeRoleStarter(id, 'role-school:first-exam-analysis')).toThrow('Starter unavailable')
    const updated = await updatePlugin(id)
    await confirmPluginInstall(updated.token, {})
    expect(listRoleStarters()[0].starters[0].completed).toBe(true)
    expect(roleCatalog().find((c) => c.id === id)).toMatchObject({ group: 'other', enabled: true, counts: { starters: 3 } })
    dismissRoleStarters(id)
    replacePluginRegistry(id)
    db.close()
    db = new Database(join(env.root, 'test.db'))
    db.loadExtension(getLoadablePath())
    env.db = drizzle(db, { schema })
    await initializePlugins()
    expect(listRoleStarters()).toEqual([])
    await uninstallPlugin(id)
    const reinstalled = await inspectPluginPath(join(process.cwd(), 'resources/marketplace/plugins/role-kaoyan'))
    await confirmPluginInstall(reinstalled.token, {})
    expect(listRoleStarters()[0].starters.every((s) => !s.completed)).toBe(true)
    for (const starter of listRoleStarters()[0].starters) completeRoleStarter(id, starter.id)
    expect(listRoleStarters()).toEqual([])
    expect(env.calls).toEqual([])
    expect(env.db!.select().from(schema.aiTasks).all()).toEqual([])
  })

  it('owns combined role tokens, cancels without installation, confirms once and exposes exact actual counts', async () => {
    await initializeMarkets()
    const cards = roleCatalog()
    expect(cards.map((c) => c.name)).toEqual([
      'role-school',
      'role-research',
      'role-kaoyan',
      'role-jobseeker',
      'role-product',
      'role-teacher',
      'role-creator',
      'role-manager'
    ])
    expect(cards.map((c) => c.group)).toEqual(['student', 'student', 'student', 'student', 'work', 'work', 'work', 'work'])
    expect(cards[2].counts).toEqual({ skills: 4, lenses: 1, templates: 3, frameworks: 1, recipes: 2, starters: 3, feeds: 1 })
    const ids = ['role-school@jiwei', 'role-kaoyan@jiwei']
    const canceled = beginRoleSelection(7)
    const first = await previewRoles(7, canceled, ids)
    expect(first.roles.map((r) => r.id)).toEqual(ids)
    expect(first.roles.every((r) => !('token' in r))).toBe(true)
    expect(listStarters()).toEqual([])
    await expect(
      confirmRoles(
        8,
        canceled,
        first.roles.map((r) => ({ id: r.id, options: {} }))
      )
    ).rejects.toThrow('Invalid role selection')
    await cancelRoleSelection(7, canceled)
    await expect(
      confirmRoles(
        7,
        canceled,
        first.roles.map((r) => ({ id: r.id, options: {} }))
      )
    ).rejects.toThrow('Invalid role selection')
    expect(listStarters()).toEqual([])
    const token = beginRoleSelection(7)
    const preview = await previewRoles(7, token, ids)
    await expect(confirmRoles(7, token, [{ id: ids[0], options: {} }])).rejects.toThrow('Selection does not match')
    expect(listStarters()).toEqual([])
    const result = await confirmRoles(
      7,
      token,
      preview.roles.map((r) => ({ id: r.id, options: {} }))
    )
    expect(result).toMatchObject({ selected: ids, installed: ids, remaining: [], status: 'complete' })
    expect(
      roleCatalog()
        .filter((c) => c.enabled === true)
        .map((c) => c.id)
    ).toEqual(ids)
    expect(listStarters()).toHaveLength(6)
    expect(env.db!.select().from(schema.aiTasks).all()).toEqual([])
    await initializePlugins()
    expect(roleRecovery()).toEqual(result)
    await expect(
      confirmRoles(
        7,
        token,
        preview.roles.map((r) => ({ id: r.id, options: {} }))
      )
    ).rejects.toThrow('Invalid role selection')
  })

  it('preserves committed roles after a second install fails and recovers through database reopen and explicit retry', async () => {
    await initializeMarkets()
    const ids = ['role-school@jiwei', 'role-kaoyan@jiwei']
    const token = beginRoleSelection(7)
    await previewRoles(7, token, ids)
    env.onAudit = (entry) => {
      if (entry.summary === 'install: role-kaoyan@jiwei') throw new Error('Controlled audit failure')
    }
    const result = await confirmRoles(
      7,
      token,
      ids.map((id) => ({ id, options: {} }))
    )
    expect(result).toMatchObject({ status: 'partial', installed: [ids[0]], remaining: [ids[1]], error: 'Controlled audit failure' })
    expect(listStarters()).toHaveLength(3)
    expect(
      env
        .db!.select()
        .from(schema.plugins)
        .all()
        .map((p) => p.id)
        .sort()
    ).toEqual(['product@local', ids[0]])
    db.close()
    db = new Database(join(env.root, 'test.db'))
    db.loadExtension(getLoadablePath())
    env.db = drizzle(db, { schema })
    await initializePlugins()
    expect(roleRecovery()).toEqual(result)
    env.onAudit = undefined
    await setPluginEnabled(ids[0], false)
    const retry = beginRoleSelection(7)
    const preview = await previewRoles(7, retry, ids)
    expect(preview.alreadyInstalled).toEqual([ids[0]])
    expect(preview.roles.map((r) => r.id)).toEqual([ids[1]])
    expect(await confirmRoles(7, retry, [{ id: ids[1], options: {} }])).toMatchObject({ status: 'complete', remaining: [] })
    expect(roleCatalog().find((r) => r.id === ids[0])?.enabled).toBe(false)
    expect(listStarters()).toHaveLength(3)
  })

  it('cancels in-flight combined installation without rolling back a committed role or installing the remainder', async () => {
    await initializeMarkets()
    const ids = ['role-school@jiwei', 'role-kaoyan@jiwei']
    const token = beginRoleSelection(7)
    await previewRoles(7, token, ids)
    env.onAudit = (entry) => {
      if (entry.summary === 'install: role-school@jiwei') void cancelRoleSelection(7, token)
    }
    const result = await confirmRoles(
      7,
      token,
      ids.map((id) => ({ id, options: {} }))
    )
    expect(result).toMatchObject({ status: 'canceled', installed: [ids[0]], remaining: [ids[1]] })
    expect(listStarters()).toHaveLength(3)
    expect(roleRecovery()).toEqual(result)
  })

  it('rejects expired and namespace-raced previews, and uses stable identity order for timestamp ties', async () => {
    await initializeMarkets()
    const ids = ['role-school@jiwei', 'role-kaoyan@jiwei']
    const expired = beginRoleSelection(7)
    const preview = await previewRoles(7, expired, ids)
    const now = vi.spyOn(Date, 'now').mockReturnValue(preview.expiresAt)
    await expect(
      confirmRoles(
        7,
        expired,
        ids.map((id) => ({ id, options: {} }))
      )
    ).rejects.toThrow('expired')
    expect(listStarters()).toEqual([])
    now.mockRestore()
    await cancelRoleSelection(7, expired)
    const raced = beginRoleSelection(7)
    await previewRoles(7, raced, ids)
    const local = await inspectPluginPath(join(process.cwd(), 'resources/marketplace/plugins/role-kaoyan'))
    await confirmPluginInstall(local.token, {})
    const result = await confirmRoles(
      7,
      raced,
      ids.map((id) => ({ id, options: {} }))
    )
    expect(result).toMatchObject({ status: 'partial', installed: [ids[0]], remaining: [ids[1]] })
    expect(result.error).toContain('namespace')
    await uninstallPlugin('role-kaoyan@local')
    await uninstallPlugin(ids[0])
    const tiedClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    const tied = beginRoleSelection(7)
    await previewRoles(7, tied, ids)
    expect(
      await confirmRoles(
        7,
        tied,
        ids.map((id) => ({ id, options: {} }))
      )
    ).toMatchObject({ status: 'complete' })
    expect(listRoleStarters().map((r) => r.pluginId)).toEqual([ids[1], ids[0]])
    tiedClock.mockRestore()
    const unchanged = beginRoleSelection(7)
    const existing = await previewRoles(7, unchanged, ids)
    expect(existing.roles).toEqual([])
    expect(existing.alreadyInstalled).toEqual(ids)
    expect(await confirmRoles(7, unchanged, [])).toMatchObject({ status: 'complete', remaining: [] })
  })

  it('cleans canceled acquisition and window-owned previews without leaving installed roles', async () => {
    await initializeMarkets()
    const token = beginRoleSelection(7)
    const pending = previewRoles(7, token, ['role-school@jiwei', 'role-kaoyan@jiwei'])
    const failure = expect(pending).rejects.toThrow()
    await cancelRoleSelection(7, token)
    await failure
    expect(listStarters()).toEqual([])
    expect(await readdir(join(env.root, 'plugins/previews'))).toEqual([])
    const prepared = beginRoleSelection(7)
    await previewRoles(7, prepared, ['role-school@jiwei'])
    await cancelOwnerRoleSelections(7)
    await expect(confirmRoles(7, prepared, [{ id: 'role-school@jiwei', options: {} }])).rejects.toThrow('Invalid role selection')
    expect(await readdir(join(env.root, 'plugins/previews'))).toEqual([])
    expect(listStarters()).toEqual([])
  })

  it('applies only explicitly selected feeds in a confirmed batch and leaves recipe tasks uncreated', async () => {
    await initializeMarkets()
    const token = beginRoleSelection(7)
    const ids = ['role-school@jiwei', 'role-kaoyan@jiwei']
    await previewRoles(7, token, ids)
    expect(
      await confirmRoles(7, token, [
        { id: ids[0], options: { feeds: [0] } },
        { id: ids[1], options: { feeds: [] } }
      ])
    ).toMatchObject({ status: 'complete' })
    expect(
      env
        .db!.select()
        .from(schema.feeds)
        .all()
        .map((f) => ({ pluginId: f.pluginId, enabled: f.enabled }))
    ).toEqual([{ pluginId: ids[0], enabled: true }])
    expect(env.db!.select().from(schema.aiTasks).all()).toEqual([])
    expect(env.calls).toEqual([])
    await uninstallPlugin(ids[0])
    expect(
      env
        .db!.select()
        .from(schema.feeds)
        .all()
        .map((f) => f.pluginId)
    ).toEqual([null])
    expect(listRoleStarters().map((r) => r.pluginId)).toEqual([ids[1]])
  })

  it('downloads a shared third-party repository once per combined preview and keeps source-owned capabilities', async () => {
    await initializeMarkets()
    const catalog = {
      name: 'selfroles',
      owner: { name: 'Self-authored fixture' },
      plugins: ['first', 'second'].map((name) => ({ name, source: `./plugins/${name}` }))
    }
    const zip = new JSZip()
    zip.file('repo/.claude-plugin/marketplace.json', JSON.stringify(catalog))
    for (const name of ['first', 'second']) {
      zip.file(`repo/plugins/${name}/.claude-plugin/plugin.json`, JSON.stringify({ name }))
      zip.file(`repo/plugins/${name}/jiwei/manifest.json`, JSON.stringify({ schema: 1, category: 'role' }))
    }
    const archive = await zip.generateAsync({ type: 'nodebuffer' })
    const hits: string[] = []
    const server = createServer((req, res) => {
      hits.push(req.url!)
      if (req.url === '/self/roles/main/.claude-plugin/marketplace.json') res.end(JSON.stringify(catalog))
      else if (req.url === '/repos/self/roles/commits/main') res.end('a'.repeat(40))
      else if (req.url === `/self/roles/zip/${'a'.repeat(40)}`) res.end(archive)
      else {
        res.statusCode = 404
        res.end('missing')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    for (const key of ['RAW', 'API', 'CODELOAD']) process.env[`JIWEI_GITHUB_${key}`] = base
    try {
      await addMarket({ kind: 'github', url: 'https://github.com/self/roles/tree/main' })
      hits.length = 0
      const token = beginRoleSelection(7)
      const preview = await previewRoles(7, token, ['first@selfroles', 'second@selfroles'])
      expect(hits.filter((url) => url.includes('/zip/'))).toHaveLength(1)
      expect(preview.roles.map((r) => r.origin.market)).toEqual(['selfroles', 'selfroles'])
      expect(preview.roles.every((r) => r.category === 'role')).toBe(true)
      await cancelRoleSelection(7, token)
      expect(
        env
          .db!.select()
          .from(schema.plugins)
          .all()
          .map((p) => p.id)
      ).toEqual(['product@local'])
    } finally {
      for (const key of ['RAW', 'API', 'CODELOAD']) delete process.env[`JIWEI_GITHUB_${key}`]
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  it('returns only validated four-surface navigation including builtin recipes without task creation or model calls', async () => {
    await file(join(source, 'jiwei/manifest.json'), { schema: 1, category: 'role' })
    await mkdir(join(source, 'skills/read'), { recursive: true })
    await writeFile(join(source, 'skills/read/SKILL.md'), '---\nname: read\ndescription: Read user material\n---\nRead only supplied text.')
    const text = { zh: '先看材料', en: 'Read the material' }
    const actions = [
      { kind: 'chat', skill: 'product:read', prompt: text },
      { kind: 'advisor', framework: 'product:a', question: text },
      { kind: 'work', template: 'product:a' },
      { kind: 'recipe', recipe: 'product:a' },
      { kind: 'recipe', recipeRef: 'exam-plan' }
    ]
    await file(
      join(source, 'jiwei/starters.json'),
      actions.map((action, i) => ({ id: `start-${i}`, title: text, body: text, action }))
    )
    const preview = await updatePlugin('product@local')
    await confirmPluginInstall(preview.token, {})
    expect(listRoleStarters()).toHaveLength(1)
    for (const [i, action] of actions.entries()) expect(completeRoleStarter('product@local', `product:start-${i}`)).toEqual(action)
    expect(listRoleStarters()).toEqual([])
    expect(env.calls).toEqual([])
    expect(env.db!.select().from(schema.aiTasks).all()).toEqual([])
  })

  for (const existing of [false, true])
    it(`does not resurrect recipe provenance after uninstall during ${existing ? 'edit' : 'create'}`, async () => {
      const recipe = recipes().find((r) => r.id === 'product:a')!
      const old = existing ? await saveTask({ ...recipe.task, enabled: false }) : undefined
      let release!: () => void, reached!: () => void
      const gate = new Promise<void>((r) => {
          release = r
        }),
        ready = new Promise<void>((r) => {
          reached = r
        })
      env.toolGate = async () => {
        reached()
        await gate
      }
      const pending = saveTask({ ...recipe.task, ...old, enabled: true })
      const outcome = existing ? pending : expect(pending).rejects.toThrow('Recipe unavailable')
      await ready
      await uninstallPlugin('product@local', { removeFeeds: false, removeTasks: false })
      release()
      const result = await outcome
      if (existing) expect((result as { pluginId: string | null }).pluginId).toBeNull()
      else expect(env.db!.select().from(schema.aiTasks).all()).toHaveLength(0)
      env.toolGate = undefined
    })

  it('keeps maximum-length template guidance and framework questions inside complete external-data inputs', async () => {
    const escaped = String.fromCharCode(1)
    const localized = { zh: escaped.repeat(4000), en: escaped.repeat(4000) }
    await file(join(source, 'jiwei/templates/long.json'), {
      id: 'long',
      type: 'article',
      title: localized,
      audience: escaped.repeat(500),
      mode: escaped.repeat(100),
      description: localized,
      outline: Array.from({ length: 12 }, () => escaped.repeat(2000)),
      guidance: escaped.repeat(1978) + 'TAIL_TEMPLATE_GUIDANCE'
    })
    await file(join(source, 'jiwei/frameworks/long.json'), {
      id: 'long',
      title: localized,
      description: localized,
      criteria: Array.from({ length: 8 }, (_, i) => ({ name: escaped.repeat(198) + String(i), weight: 3, hint: escaped.repeat(2000) })),
      questions: Array.from({ length: 8 }, (_, i) => escaped.repeat(1985) + `TAIL_QUESTION_${i}`)
    })
    const preview = await updatePlugin('product@local')
    await confirmPluginInstall(preview.token, {})
    const work = createWork({ templateId: 'product:long', type: 'article', mode: 'cowrite' })
    await generateOutline(work.id)
    expect(env.calls.at(-1)!.prompt).toContain('<external-data source="works.selectedTemplate">')
    expect(env.calls.at(-1)!.prompt).toContain('TAIL_TEMPLATE_GUIDANCE')
    expect(env.calls.at(-1)!.prompt).not.toContain('已截断')
    await ask({ question: 'Which long framework applies?', frameworkId: 'product:long' })
    expect(env.calls.at(-1)!.prompt).toContain('<external-data source="advisor.selectedFramework">')
    expect(env.calls.at(-1)!.prompt).toContain('TAIL_QUESTION_7')
    expect(env.calls.at(-1)!.prompt).not.toContain('已截断')
    expect(env.calls.at(-1)!.system).not.toContain('TAIL_QUESTION_7')
  })

  it('seeds real work and keeps the selected template in generation after restart, disable and uninstall', async () => {
    const work = createWork({
      type: 'article',
      templateId: 'product:a',
      title: 'Retained title',
      topic: 'Actual topic',
      audience: 'Beginners',
      mode: 'coach'
    })
    expect(work.content?.parts.map((p) => p.title)).toEqual(['Evidence first', 'Next steps'])
    expect(work.template?.guidance).toBe('UNTRUSTED_TEMPLATE_MARKER')
    expect(work).toMatchObject({ type: 'article', audience: 'Beginners', mode: 'coach', title: 'Retained title' })
    updateWork({ id: work.id, stage: 'outline' })
    db.close()
    db = new Database(join(env.root, 'test.db'))
    db.loadExtension(getLoadablePath())
    env.db = drizzle(db, { schema })
    await initializePlugins()
    await setPluginEnabled('product@local', false)
    expect(() => createWork({ type: 'article', templateId: 'product:a', mode: 'cowrite' })).toThrow('Template unavailable')
    await uninstallPlugin('product@local', { removeFeeds: false, removeTasks: false })
    await generateOutline(work.id)
    const call = env.calls.at(-1)!
    expect(call.prompt).toContain('UNTRUSTED_TEMPLATE_MARKER')
    expect(call.prompt).toContain('<external-data source=')
    expect(call.system).not.toContain('UNTRUSTED_TEMPLATE_MARKER')
    expect(getWork(work.id).template?.id).toBe('product:a')
    expect(getWork(work.id).content?.parts[0].title).toBe('First')
  })
  it('persists framework before model failure and retries using saved criteria/questions after uninstall', async () => {
    env.failure = true
    await expect(ask({ question: 'Which choice has evidence?', frameworkId: 'product:a' })).rejects.toThrow(
      'Controlled provider unavailable'
    )
    const draft = listDecisions()[0]
    expect(draft.framework?.criteria[0].weight).toBe(5)
    expect(draft.status).toBe('draft')
    env.failure = false
    env.onAudit = undefined
    await uninstallPlugin('product@local', { removeFeeds: false, removeTasks: false })
    await regenerate(draft.id)
    const call = env.calls.at(-1)!
    expect(call.prompt).toContain('UNTRUSTED_FRAMEWORK_MARKER')
    expect(call.prompt).toContain('What evidence is missing?')
    expect(call.prompt).toContain('<external-data source=')
    expect(call.system).not.toContain('UNTRUSTED_FRAMEWORK_MARKER')
    expect(getDecision(draft.id).memo?.options).toHaveLength(2)
  })
  it('persists the maximum legal criterion weight and rejects names beyond the shared contract', async () => {
    const decision = await ask({ question: 'Which weights are legal?', frameworkId: 'product:a' })
    const name = '准'.repeat(200)
    setWeights(decision.id, { [name]: 3, Cost: 4 })
    expect(getDecision(decision.id).weights).toEqual({ [name]: 3, Cost: 4 })
    expect(() => setWeights(decision.id, { ['准'.repeat(201)]: 2 })).toThrow()
    expect(getDecision(decision.id).weights?.[name]).toBe(3)
    expect(setWeights(decision.id, null).weights).toBeNull()
  })
  it('rejects stale selection and preserves the ordinary create and advisor flows', async () => {
    expect(() => createWork({ type: 'slides', templateId: 'product:a', mode: 'cowrite' })).toThrow('does not match')
    await expect(ask({ question: 'Which option is better?', frameworkId: 'absent' })).rejects.toThrow('Framework unavailable')
    expect(createWork({ type: 'article', title: 'Ordinary', mode: 'cowrite' }).template).toBeNull()
    expect((await ask({ question: 'Which ordinary choice is better?' })).memo?.options).toHaveLength(2)
  })
  it('uses registry recipes, main-owned provenance and retains user tasks through plugin removal', async () => {
    const recipe = recipes().find((r) => r.id === 'product:a')!
    expect(recipe.pluginId).toBe('product@local')
    expect(recipe.task.recipe).toBe('product:a')
    const task = await saveTask({ ...recipe.task, enabled: false })
    expect(task.pluginId).toBe('product@local')
    await setPluginEnabled('product@local', false)
    expect(recipes().some((r) => r.id === 'product:a')).toBe(false)
    await expect(saveTask({ ...recipe.task, enabled: false })).rejects.toThrow('Recipe unavailable')
    expect((await saveTask({ ...task, name: 'User edit' })).pluginId).toBe('product@local')
    await uninstallPlugin('product@local', { removeFeeds: false, removeTasks: false })
    const saved = await saveTask({ ...task, name: 'Retained user edit' })
    expect(saved.pluginId).toBeNull()
    await expect(saveTask({ ...recipe.task, recipe: 'forged:a', enabled: false })).rejects.toThrow('Recipe unavailable')
    expect((await saveTask({ ...recipe.task, recipe: null, enabled: false, ...{ pluginId: 'forged@local' } })).pluginId).toBeNull()
  })
  it('preserves tool, budget and namespace validation', async () => {
    const r = recipes().find((x) => x.id === 'product:a')!
    await expect(saveTask({ ...r.task, enabled: true, tools: ['unavailable'] })).rejects.toThrow('unavailable or unauthorized')
    await expect(saveTask({ ...r.task, budgetPerRun: -1 })).rejects.toThrow()
    expect(TaskSave.safeParse({ ...r.task, recipe: 'p'.repeat(128) + ':' + 'r'.repeat(128) }).success).toBe(true)
    expect(TaskSave.safeParse({ ...r.task, recipe: 'p'.repeat(258) }).success).toBe(false)
  })
})

it('cancels ask without persisting a new decision even if the provider completes late', async () => {
  let release!: () => void
  env.advisorGate = new Promise<void>((r) => {
    release = r
  })
  const pending = ask({ question: 'Should I stop this question?' })
  const rejected = expect(pending).rejects.toThrow('ADVISOR_CANCELED')
  await vi.waitFor(() => expect(env.calls.some((c) => c.purpose === 'advisor.memo')).toBe(true))
  cancelGeneration('ask')
  expect(runningGenerations()).not.toContain('ask')
  release()
  await rejected
  expect(listDecisions()).toHaveLength(0)
})
it('cancels regeneration without replacing the saved memo or weights', async () => {
  const d = await ask({ question: 'Should I preserve this memo?' })
  setWeights(d.id, { Evidence: 1 })
  const before = getDecision(d.id)
  let release!: () => void
  env.advisorGate = new Promise<void>((r) => {
    release = r
  })
  const pending = regenerate(d.id)
  const rejected = expect(pending).rejects.toThrow('ADVISOR_CANCELED')
  await vi.waitFor(() => expect(runningGenerations()).toContain(d.id))
  cancelGeneration(d.id)
  release()
  await rejected
  expect(getDecision(d.id)).toEqual(before)
})
