import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getLoadablePath } from 'sqlite-vec'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider'
import type { DB } from '../../../db'
import type { AiTask } from '@shared/tasks'
import * as schema from '../../../db/schema'

type Entry = 'daily' | 'path' | 'remedy' | 'task'
type Observation = { entry: Entry; purpose: string | undefined; caller: string | undefined }
const probe = vi.hoisted(() => ({
  db: null as DB | null,
  sqlite: null as Database.Database | null,
  model: null as MockLanguageModelV4 | null,
  entry: 'daily' as Entry,
  atSearch: [] as Observation[],
  atNetwork: [] as Observation[],
  modelPurposes: [] as (string | undefined)[],
  requests: [] as RequestInit[],
  received: [] as { path: string; query: string }[],
  meta: new Map<string, string>(),
  notes: [] as unknown[],
  proposals: [] as unknown[],
  task: null as AiTask | null
}))

// 只替代桌面与外部服务边界；search/externalFetch 仍发出真实的 loopback 请求。
vi.mock('electron', () => ({
  app: { isPackaged: false, getLocale: () => 'en' },
  nativeTheme: {},
  Notification: { isSupported: () => false },
  net: {
    fetch: async (url: string, options: RequestInit) => {
      const { currentRun } = await import('../../agent/context')
      const run = currentRun()
      probe.atNetwork.push({ entry: probe.entry, purpose: run?.purpose, caller: run?.caller })
      probe.requests.push(options)
      if (new URL(url).hostname !== '127.0.0.1') throw new Error('Probe refuses non-loopback requests')
      return fetch(url, options)
    }
  }
}))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('../../../db', () => ({ getDb: () => probe.db, getSqlite: () => probe.sqlite }))
vi.mock('../../../events', () => ({ emit: vi.fn() }))
vi.mock('../../../mainWindow', () => ({ getMainWindow: () => null }))
vi.mock('../../device', () => ({ deviceId: () => 'purpose-probe' }))
vi.mock('../../jobs', () => ({ enqueue: vi.fn(), registerJobKind: vi.fn(), runJobNow: vi.fn(), cancelJob: vi.fn() }))
vi.mock('../../agent/audit', () => ({ audit: vi.fn() }))
vi.mock('../../mcp/secrets', () => ({
  // 密文仅是内存库里的测试标记；此替身从不读取或解密用户密钥。
  openJson: () => 'synthetic-purpose-probe-token',
  sealJson: () => Buffer.from('synthetic-purpose-probe-marker')
}))
vi.mock('../../ai/model', () => ({ buildModel: () => ({ model: probe.model, providerOptions: {} }) }))
vi.mock('../../ai/embedding', () => ({ isReady: async () => false }))
vi.mock('../../ai/retrieve', () => ({ retrieve: async () => [], similarTo: async () => [] }))
vi.mock('../../memory', () => ({
  getMeta: (key: string) => probe.meta.get(key) ?? null,
  setMeta: (key: string, value: string) => probe.meta.set(key, value)
}))
vi.mock('../../progress', () => ({
  listGoals: () => [
    { id: 'probe-goal', title: 'Controlled learning', description: 'Purpose probe', status: 'active', kind: 'topic', categoryId: null }
  ],
  masteryMap: () => ({ notes: [] })
}))
vi.mock('../../learner', () => ({ listConcepts: () => [] }))
vi.mock('../../plan/phases', () => ({ phases: () => [] }))
vi.mock('../../plan/schedule', () => ({ previewPathPhases: vi.fn() }))
vi.mock('../../mistakesPrivacy', () => ({
  requireMistakeCloud: vi.fn(),
  requireMistake: () => ({
    id: 'probe-mistake',
    concepts: '["Controlled concept"]',
    cause: 'understanding',
    question: 'Controlled question',
    causeReason: 'Purpose probe',
    updatedAt: 1
  })
}))
vi.mock('../../notes', () => ({
  createNote: (input: unknown) => {
    probe.notes.push(input)
    return { id: 'probe-note' }
  }
}))
vi.mock('../../proposals', () => ({
  createProposal: (input: unknown) => {
    probe.proposals.push(input)
    return { id: 'probe-proposal', noteId: 'probe-note' }
  }
}))
vi.mock('../../reflection', () => ({ createAction: vi.fn() }))
vi.mock('../../inbox', () => ({ create: vi.fn() }))
vi.mock('../../sources', () => ({ addUrl: vi.fn(), importContent: vi.fn() }))
vi.mock('../../webText', () => ({ fetchWebText: vi.fn() }))
vi.mock('../../discover/items', () => ({
  publishPick: vi.fn(),
  restoreLater: vi.fn(),
  dailyDeliveries: () => [],
  scoreAllowed: () => true
}))
vi.mock('../../ai/tools', () => ({ buildTools: () => ({}) }))
vi.mock('../../ai/doTools', () => ({ BUILTIN_META: {}, buildDoTools: () => ({ tools: {}, meta: {} }), isProposalTool: () => false }))
vi.mock('../../mcp/client', () => ({ assistantMcpTools: async () => ({ tools: {}, meta: {} }) }))
vi.mock('../../mail/tools', () => ({ mailTools: () => ({ tools: {}, meta: {} }) }))
vi.mock('../../tasks/service', () => ({
  getTask: () => probe.task,
  changed: vi.fn(),
  taskRuns: () => [],
  recordTaskCost: vi.fn()
}))

import { currentRun, withRun } from '../../agent/context'
import { runDaily } from '../../discover/daily'
import { path, remedy } from '../../discover/path'
import { runTask } from '../../tasks/runner'
import * as searchModule from '../../discover/search'
import { getSettings } from '../../settings'

const articleUrl = 'https://purpose.example/article'
const originalSearch = searchModule.search
let sqlite: Database.Database
let server: Server
let taskStep: number
const modelResult = (
  content: LanguageModelV4GenerateResult['content'],
  reason: LanguageModelV4GenerateResult['finishReason']['unified']
): LanguageModelV4GenerateResult => ({
  content,
  finishReason: { unified: reason, raw: reason },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 }
  },
  warnings: []
})

beforeEach(async () => {
  sqlite = new Database(':memory:')
  probe.sqlite = sqlite
  sqlite.loadExtension(getLoadablePath())
  probe.db = drizzle(sqlite, { schema })
  migrate(probe.db, { migrationsFolder: 'resources/migrations' })
  probe.atSearch = []
  probe.atNetwork = []
  probe.modelPurposes = []
  probe.requests = []
  probe.received = []
  probe.meta.clear()
  probe.notes = []
  probe.proposals = []
  taskStep = 0
  probe.db
    .insert(schema.searchConnections)
    .values({
      service: 'bocha',
      keyEnc: Buffer.from('synthetic-purpose-probe-marker'),
      enabled: true,
      updatedAt: 1
    })
    .run()
  for (const [key, value] of Object.entries({
    language: 'en',
    ai: {
      chat: { providerId: 'probe-provider', model: 'purpose-probe' },
      effort: 'off',
      embedding: { mode: 'local', providerId: null, model: null }
    },
    discover: { dailyLimit: 5, dailyBudget: 10, budgetCurrency: 'USD', useSearch: true }
  }))
    probe.db
      .insert(schema.settings)
      .values({ key, value: JSON.stringify(value) })
      .run()
  const task: AiTask = {
    id: 'probe-task',
    name: 'Controlled search task',
    instruction: 'Search the controlled topic',
    trigger: { type: 'manual' },
    tools: ['web_search'],
    outputs: {},
    budgetPerRun: null,
    enabled: true,
    recipe: null,
    pluginId: null,
    lastRunAt: null,
    nextRunAt: null,
    lastResult: null,
    monthCost: 0
  }
  probe.task = task
  probe.db
    .insert(schema.aiTasks)
    .values({
      id: task.id,
      name: task.name,
      instruction: task.instruction,
      budgetPerRun: task.budgetPerRun,
      enabled: task.enabled,
      trigger: JSON.stringify(task.trigger),
      tools: JSON.stringify(task.tools),
      outputs: JSON.stringify(task.outputs),
      createdAt: 1,
      updatedAt: 1,
      updatedBy: 'purpose-probe'
    })
    .run()
  // 保留 AI SDK 的工具执行与 structured 的 withPurpose；模型替身仅提供受控返回。
  probe.model = new MockLanguageModelV4({
    doGenerate: async () => {
      await Promise.resolve()
      const purpose = currentRun()?.purpose
      probe.modelPurposes.push(purpose)
      if (purpose === 'task') {
        if (taskStep++ === 0)
          return modelResult(
            [
              {
                type: 'tool-call',
                toolCallId: 'probe-web-search',
                toolName: 'web_search',
                input: JSON.stringify({ query: 'Controlled task query', count: 8 })
              }
            ],
            'tool-calls'
          )
        return modelResult([{ type: 'text', text: 'Controlled web search finished.' }], 'stop')
      }
      const input =
        purpose === 'discover.queries'
          ? { queries: ['Controlled query one', 'Controlled query two', 'Controlled query three'] }
          : purpose === 'discover.score'
            ? { items: [] }
            : purpose === 'discover.path'
              ? {
                  steps: Array.from({ length: 4 }, (_, i) => ({
                    title: `Step ${i + 1}`,
                    question: `Question ${i + 1}`,
                    objective: 'Learn the controlled topic',
                    resourceIds: [articleUrl]
                  }))
                }
              : purpose === 'discover.remedy'
                ? { resources: [] }
                : null
      if (!input) throw new Error(`Unexpected controlled model purpose: ${purpose}`)
      return modelResult(
        [{ type: 'tool-call', toolCallId: `probe-${purpose}`, toolName: 'submit', input: JSON.stringify(input) }],
        'tool-calls'
      )
    }
  })
  vi.spyOn(searchModule, 'search').mockImplementation((...args) => {
    const run = currentRun()
    probe.atSearch.push({ entry: probe.entry, purpose: run?.purpose, caller: run?.caller })
    return originalSearch(...args)
  })
  server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    const request = JSON.parse(body) as { query: string }
    probe.received.push({ path: req.url ?? '', query: request.query })
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        data: { webPages: { value: [{ url: articleUrl, title: 'Controlled article', summary: 'Controlled learning material.' }] } }
      })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  vi.stubEnv('JIWEI_SEARCH_BASE', `http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  vi.stubEnv('JIWEI_TEST_NETWORK', '1')
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  sqlite.close()
  probe.db = null
  probe.sqlite = null
})

function expectPurpose(purpose: string, count: number, caller: string): void {
  expect(probe.atSearch).toEqual(Array.from({ length: count }, () => ({ entry: probe.entry, purpose, caller })))
  expect(probe.atNetwork).toEqual(probe.atSearch)
  expect(probe.received).toHaveLength(count)
  expect(probe.received.every((request) => request.path === '/bocha')).toBe(true)
  expect(probe.requests.every((request) => request.credentials === 'omit' && request.redirect === 'manual')).toBe(true)
  expect(probe.requests.every((request) => !new Headers(request.headers).has('user-agent'))).toBe(true)
  expect(currentRun()).toBeUndefined()
  console.info('P0_PURPOSE', JSON.stringify({ atSearch: probe.atSearch, atNetwork: probe.atNetwork, received: probe.received.length }))
}

describe('P0 production search caller purposes', () => {
  it('daily search restores discover.daily after the real discover.queries structured call', async () => {
    probe.entry = 'daily'
    expect(getSettings().discover.useSearch).toBe(true)
    const result = await withRun({ purpose: 'probe.outer', caller: 'job' }, () => runDaily())
    expect(result.status).toBe('ok')
    expect(probe.modelPurposes).toEqual(['discover.queries', 'discover.score'])
    expect(sqlite.prepare('select count(*) as n from feed_items').get()).toEqual({ n: 1 })
    expectPurpose('discover.daily', 3, 'job')
  }, 20000)

  it('learning path resources search observes discover.path', async () => {
    probe.entry = 'path'
    const result = await path('probe-goal')
    expect(result.steps).toHaveLength(4)
    expect(result.steps[0].resources[0].url).toBe(articleUrl)
    expect(probe.notes).toHaveLength(1)
    expect(probe.proposals).toHaveLength(1)
    expect(probe.modelPurposes).toEqual(['discover.path'])
    expectPurpose('discover.path', 1, 'app')
  }, 20000)

  it('mistake remedy reaches the same resources search under discover.remedy', async () => {
    probe.entry = 'remedy'
    expect(await remedy('probe-mistake')).toEqual([])
    expect(probe.modelPurposes).toEqual(['discover.remedy'])
    expectPurpose('discover.remedy', 1, 'app')
  }, 20000)

  it('task runner, task policy and guarded web_search execute under task', async () => {
    probe.entry = 'task'
    const result = await runTask('probe-task', { type: 'manual' }, false, {
      isCanceled: () => false,
      progress: () => undefined,
      worker: async () => {
        throw new Error('Purpose probe does not run workers')
      }
    })
    const run = probe.db!.select().from(schema.aiTaskRuns).get()
    expect(run).toMatchObject({ id: result.runId, status: 'ok', error: null })
    expect(probe.modelPurposes).toEqual(['task', 'task'])
    expect(
      probe.model!.doGenerateCalls[1].prompt.some((message) => message.role === 'tool' && JSON.stringify(message).includes(articleUrl))
    ).toBe(true)
    expectPurpose('task', 1, 'task:Controlled search task')
  }, 20000)
})
