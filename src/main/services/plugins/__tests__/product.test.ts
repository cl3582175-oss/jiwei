import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import Database from 'better-sqlite3'
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
  toolGate: undefined as (() => Promise<void>) | undefined
}))
vi.mock('electron', () => ({
  app: { getPath: () => env.root, getAppPath: () => env.root, getVersion: () => 'test', isPackaged: false },
  dialog: {},
  shell: {},
  net: { fetch: vi.fn() },
  safeStorage: {},
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../../../db', () => ({ getDb: () => env.db, getSqlite: () => null }))
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
vi.mock('../../agent/audit', () => ({ audit: vi.fn() }))
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
import { replacePluginRegistry } from '../registry'
import { createWork, generateOutline, getWork, updateWork } from '../../works'
import { ask, getDecision, listDecisions, regenerate, setWeights } from '../../advisor'
import { recipes, saveTask } from '../../tasks/service'
import { TaskSave } from '@shared/tasks'
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
  db.close()
  env.db = null
  await rm(root, { recursive: true, force: true })
})
describe('plugin selections enter persisted product paths', () => {
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
