import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ServerResponse, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskInput } from '../src/shared/tasks'

test.describe.configure({ mode: 'default' })
let app: ElectronApplication,
  page: Page,
  server: Server,
  base = '',
  releasePage: (() => void) | null = null,
  webRevision = 1
const requests: { body: string; system: string }[] = [],
  searchRequests: string[] = [],
  calendarRequests: string[] = []
const task = (name: string, rest: Partial<TaskInput> = {}): TaskInput => ({
  name,
  instruction: name,
  trigger: { type: 'manual' },
  tools: [],
  outputs: { inbox: true },
  ...rest
})
const textOf = (v: unknown): string =>
  typeof v === 'string' ? v : Array.isArray(v) ? v.map((p: { text?: string }) => p.text ?? '').join('') : ''
function respond(res: ServerResponse, value: string | null, name?: string, args: unknown = {}) {
  res.writeHead(200, { 'content-type': 'application/json' }).end(
    JSON.stringify({
      id: 'repair',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-flash',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: value,
            ...(name ? { tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : {})
          },
          finish_reason: name ? 'tool_calls' : 'stop'
        }
      ],
      usage: { prompt_tokens: 100, completion_tokens: 500, total_tokens: 600 }
    })
  )
}
async function sql(query: string, args: unknown[] = [], read = false): Promise<Record<string, unknown>[]> {
  return app.evaluate(
    ({ app }, { query, args, read }) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath() + '/package.json'),
        db = new (load('better-sqlite3'))(process.getBuiltinModule('path').join(app.getPath('userData'), 'data/jiwei.db'))
      try {
        return read ? db.prepare(query).all(...args) : (db.prepare(query).run(...args), [])
      } finally {
        db.close()
      }
    },
    { query, args, read }
  )
}
async function runTask(id: string) {
  await page.evaluate((id) => window.jiwei.tasks.run(id), id)
  await expect
    .poll(async () => (await page.evaluate((id) => window.jiwei.tasks.runs(id), id))[0]?.status, { timeout: 15000 })
    .toMatch(/^(ok|error|budget|skipped|canceled)$/)
  return (await page.evaluate((id) => window.jiwei.tasks.runs(id), id))[0]
}
async function daily() {
  await page.evaluate(() => window.jiwei.discover.runNow())
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.discover.status())).status, { timeout: 20000 }).toBe('ok')
}
const score = (reason = '补足回归方向的推理缺口') => ({
  relevance: 5,
  novelty: 4,
  credibility: 4,
  depth: 4,
  minutes: 15,
  reason,
  gap: '推理',
  related: [],
  goalIds: [],
  diverse: false,
  news: false
})
async function candidate(id: string, url: string, cached?: unknown) {
  await sql(
    "INSERT INTO feed_items(id,url,title,summary,origin,status,score,reason,related,fetched_at,created_at,updated_at,updated_by) VALUES (?,?,?,'公开资料','search',?,?,?,?,?,?,?,'test')",
    [
      id,
      url,
      '公开讲解 ' + id,
      cached ? 'scored' : 'new',
      cached ? JSON.stringify(cached) : null,
      cached ? (cached as { reason: string }).reason : null,
      cached ? JSON.stringify((cached as { related: unknown[] }).related) : '[]',
      Date.now(),
      Date.now(),
      Date.now()
    ]
  )
}
test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ics') {
      calendarRequests.push(String(req.headers['if-none-match'] ?? ''))
      if (req.headers['if-none-match']) {
        res.writeHead(304).end()
        return
      }
      const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
      res
        .writeHead(200, { etag: 'recurring-v1', 'content-type': 'text/calendar' })
        .end(
          `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:rolling\r\nDTSTART:${date}T080000Z\r\nDTEND:${date}T090000Z\r\nRRULE:FREQ=DAILY\r\nSUMMARY:滚动讨论\r\nEND:VEVENT\r\nEND:VCALENDAR`
        )
      return
    }
    if (req.url === '/slow-page') {
      releasePage = () => res.writeHead(200, { 'content-type': 'text/html' }).end('<article>PRIVATE_INFLIGHT_TOKEN</article>')
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/search/tavily') {
        searchRequests.push(body)
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ results: [{ url: 'https://example.org/fact', title: '搜索事实', content: 'SEARCH_FACT_TOKEN' }] }))
        return
      }
      if (!req.url?.startsWith('/v1')) {
        res
          .writeHead(200, { 'content-type': 'text/html' })
          .end(`<html><head><title>公开网页</title></head><body><article>公开学习说明 ${webRevision}</article></body></html>`)
        return
      }
      const input = JSON.parse(body),
        system = textOf(input.messages.find((m: { role: string }) => m.role === 'system')?.content)
      requests.push({ body, system })
      const done = input.messages.flatMap(
        (m: { tool_calls?: { function: { name: string } }[] }) => m.tool_calls?.map((c) => c.function.name) ?? []
      )
      // 任务说明在用户消息里（作为用户保存的请求数据），不在系统提示里
      if (body.includes('SEARCH_TASK')) {
        if (!done.includes('web_search')) respond(res, null, 'web_search', { query: '受控行业学习', count: 3, freshness: 'week' })
        else if (!done.includes('send_mail')) respond(res, null, 'send_mail', { to: 'external@example.invalid' })
        else respond(res, '搜索事实已整理。')
      } else if (body.includes('INFLIGHT_TASK')) {
        if (!done.includes('web_fetch')) respond(res, null, 'web_fetch', { url: base + '/slow-page' })
        else respond(res, '不应该生成的结果')
      } else if (system.includes('Score each candidate')) {
        const raw = textOf(input.messages.find((m: { role: string }) => m.role === 'user')?.content),
          data = JSON.parse(raw.slice(raw.indexOf('\n') + 1, raw.lastIndexOf('\n')))
        respond(res, null, 'submit', { items: data.candidates.map((c: { id: string }) => ({ id: c.id, ...score() })) })
      } else if (body.includes('discover.podcast'))
        respond(res, null, 'submit', {
          paragraphs: Array.from({ length: 3 }, () => '先想一想条件何时成立，再阅读公开材料对照自己的理解。'.repeat(20))
        })
      else respond(res, '受控结果')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  app = await electron.launch({
    args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'jiwei-v08-repairs-'))}`],
    env: {
      ...process.env,
      JIWEI_LANG: 'zh-CN',
      JIWEI_SKIP_ONBOARDING: '1',
      JIWEI_TEST_NETWORK: '1',
      JIWEI_TEST_MAIL: 'fixture',
      JIWEI_SEARCH_BASE: base + '/search',
      JIWEI_IMPORT_PROVIDERS_FROM: ''
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  await page.evaluate(async (base) => {
    const p = await window.jiwei.providers.save({ name: '受控回归', kind: 'ollama', baseUrl: base + '/v1', models: ['deepseek-flash'] }),
      s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      ai: { ...s.ai, chat: { providerId: p.id, model: 'deepseek-flash' } },
      budget: { perRun: 5, daily: 50, monthly: 500 },
      discover: { ...s.discover, useSearch: false, dailyBudget: 5 }
    })
    await window.jiwei.goals.save({ title: '回归方向', kind: 'skill' })
  }, base)
})
test.afterEach(async () => {
  releasePage?.()
  releasePage = null
  await page.evaluate(async () => {
    await window.jiwei.tasks.pauseAll(true)
    for (const t of await window.jiwei.tasks.list()) await window.jiwei.tasks.remove(t.id)
    await window.jiwei.tasks.pauseAll(false)
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ browser: { ...s.browser, aiBlockedSites: [] } })
  })
})
test.afterAll(async () => {
  await app?.close()
  await new Promise<void>((r) => server.close(() => r()))
})

test('P8 排队网页在启动前被排除，不发送缓存正文', async () => {
  const t = await page.evaluate(
    (v) => window.jiwei.tasks.save(v),
    task('QUEUED_PRIVATE_TASK', { trigger: { type: 'web', url: base + '/page' } })
  )
  await sql("INSERT INTO jobs(id,kind,payload,status,run_after,dedupe_key,created_at,updated_at) VALUES (?,'ai.task',?,'queued',?,?,?,?)", [
    'queued-private',
    JSON.stringify({ taskId: t.id, triggerInfo: { type: 'web', url: base + '/page', text: 'PRIVATE_QUEUED_TOKEN' } }),
    Date.now() + 1500,
    `task:${t.id}`,
    Date.now(),
    Date.now()
  ])
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ browser: { ...s.browser, aiBlockedSites: ['127.0.0.1'] } })
  })
  await expect
    .poll(async () => (await page.evaluate((id) => window.jiwei.tasks.runs(id), t.id))[0]?.status, { timeout: 10000 })
    .toBe('canceled')
  expect(requests.some((r) => r.body.includes('QUEUED_PRIVATE_TASK'))).toBe(false)
})

test('P8 工具读取期间隐私变化，后续模型步骤不发送旧结果', async () => {
  const t = await page.evaluate((v) => window.jiwei.tasks.save(v), task('INFLIGHT_TASK', { tools: ['web_fetch'] }))
  await page.evaluate((id) => window.jiwei.tasks.run(id), t.id)
  await expect.poll(() => !!releasePage).toBe(true)
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ browser: { ...s.browser, aiBlockedSites: ['127.0.0.1'] } })
  })
  releasePage!()
  releasePage = null
  await expect.poll(async () => (await page.evaluate((id) => window.jiwei.tasks.runs(id), t.id))[0]?.status).toBe('canceled')
  const sent = requests.filter((r) => r.body.includes('INFLIGHT_TASK'))
  expect(sent).toHaveLength(1)
  expect(sent.some((r) => r.body.includes('PRIVATE_INFLIGHT_TOKEN'))).toBe(false)
  expect((await page.evaluate((id) => window.jiwei.tasks.runs(id), t.id))[0].resultRefs).toHaveLength(0)
})

test('P8 可勾选搜索工具走真实适配、外部内容封装和后台权限', async () => {
  expect((await page.evaluate(() => window.jiwei.tasks.tools())).some((t) => t.name === 'web_search')).toBe(true)
  await page.evaluate(() => window.jiwei.discover.searchSave({ service: 'tavily', key: 'fixture-only', enabled: true }))
  const t = await page.evaluate((v) => window.jiwei.tasks.save(v), task('SEARCH_TASK', { tools: ['web_search'] }))
  const run = await runTask(t.id)
  expect(run.status).toBe('ok')
  expect(run.summary).toContain('1 个操作需要你确认')
  expect(searchRequests).toHaveLength(1)
  expect(JSON.parse(searchRequests[0])).toMatchObject({ query: '受控行业学习', max_results: 3, time_range: 'week' })
  expect(
    requests.some((r) => r.body.includes('SEARCH_TASK') && r.body.includes('SEARCH_FACT_TOKEN') && r.body.includes('<external-data'))
  ).toBe(true)
})

test('P8 账号删除、目标排除和工具失效仍允许暂停，恢复须重新校验', async () => {
  const setup = await page.evaluate(async () => {
    const account = await window.jiwei.mail.save({
        name: '临时账户',
        preset: 'qq',
        host: 'imap.qq.com',
        port: 993,
        tls: true,
        username: 'fixture@example.invalid',
        secret: 'fixture-only'
      }),
      note = await window.jiwei.notes.create({ title: '暂停目标' })
    return { account, note }
  })
  const t = await page.evaluate(
    (v) => window.jiwei.tasks.save(v),
    task('失效配置仍可暂停', {
      trigger: { type: 'mail', accountId: setup.account.id },
      tools: ['mail_read'],
      outputs: { noteId: setup.note.id }
    })
  )
  await page.evaluate(async ({ account, note }) => {
    await window.jiwei.mail.remove(account.id)
    await window.jiwei.notes.update(note.id, { aiExcluded: true })
  }, setup)
  await sql('UPDATE ai_tasks SET tools=? WHERE id=?', [JSON.stringify(['mcp_removed_tool']), t.id])
  await page.keyboard.press('ControlOrMeta+,')
  await page.getByRole('button', { name: 'AI 任务', exact: true }).click()
  await page.locator(`[data-task-id="${t.id}"]`).getByRole('switch').click()
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.tasks.list())).find((x) => x.id === t.id)?.enabled).toBe(false)
  await expect(
    page.evaluate((v) => window.jiwei.tasks.save({ ...v, enabled: true }), { ...t, tools: ['mcp_removed_tool'] })
  ).rejects.toThrow()
  await page.keyboard.press('Escape')
})

test('P8 旧打分关联笔记排除并改名后重新打分，旧理由不进入播客', async () => {
  const note = await page.evaluate(() => window.jiwei.notes.create({ title: '旧私有名称' }))
  await candidate('cached-private', 'https://cache.example.org/item', {
    ...score('PRIVATE_DERIVED_TOKEN：旧私有名称的具体推论'),
    related: [{ type: 'note', id: note.id }]
  })
  await page.evaluate((id) => window.jiwei.notes.update(id, { aiExcluded: true, title: '新私有名称' }), note.id)
  await daily()
  const item = (await page.evaluate(() => window.jiwei.discover.items(true))).find((i) => i.id === 'cached-private')!
  expect(item.status).toBe('picked')
  expect(item.reason).not.toContain('PRIVATE_DERIVED_TOKEN')
  expect(item.score?.privacySignature).toBeTruthy()
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ discover: { ...s.discover, podcast: true } })
    await window.jiwei.discover.podcastGenerate()
  })
  await expect.poll(async () => (await page.evaluate(() => window.jiwei.discover.podcast())).status, { timeout: 15000 }).toBe('ok')
  expect(requests.filter((r) => r.body.includes('discover.podcast')).some((r) => r.body.includes('PRIVATE_DERIVED_TOKEN'))).toBe(false)
})

test('P8 重复运行与网页刷新不返还同来源或每日额度', async () => {
  await sql('UPDATE feed_items SET picked_at=?', [Date.now() - 86400000])
  await sql("DELETE FROM meta WHERE key LIKE 'discover.deliveries:%'")
  for (let i = 0; i < 6; i++) await candidate(`same-host-${i}`, `https://one.example.org/${i}`)
  await daily()
  await daily()
  expect(
    (await page.evaluate(() => window.jiwei.discover.items(true))).filter((i) => i.id.startsWith('same-host-') && i.status === 'picked')
  ).toHaveLength(2)
  const feed = await page.evaluate(
    (url) => window.jiwei.discover.feedSave({ url, kind: 'web', title: '网页额度回归' }),
    base + '/quota-page'
  )
  // 网页首次抓取只建立基线；真实更新后才产生候选。
  await expect
    .poll(async () => (await page.evaluate(() => window.jiwei.discover.feeds())).find((f) => f.id === feed.id)?.lastFetchedAt)
    .toBeTruthy()
  webRevision++
  await page.evaluate((id) => window.jiwei.discover.feedRefresh(id), feed.id)
  await daily()
  const item = (await page.evaluate(() => window.jiwei.discover.items(true))).find((i) => i.feedId === feed.id)!
  expect(item.pickedAt).not.toBeNull()
  webRevision++
  await page.evaluate((id) => window.jiwei.discover.feedRefresh(id), feed.id)
  const updated = (await page.evaluate(() => window.jiwei.discover.items(true))).find((i) => i.id === item.id)!
  expect(updated.pickedAt).toBe(item.pickedAt)
  await daily()
  expect(
    (await sql("SELECT value FROM meta WHERE key LIKE 'discover.deliveries:%'", [], true)).some(
      (r) => JSON.parse(String(r.value)).length === 3
    )
  ).toBe(true)
})

test('P8 ICS 同日用304，扩展日期变化后强制重建滚动范围', async () => {
  const f = await page.evaluate((url) => window.jiwei.plan.icsSave({ name: '滚动日历', url }), base + '/ics')
  await expect
    .poll(async () => (await sql('SELECT id FROM plan_events WHERE feed_id=? AND deleted_at IS NULL', [f.id], true)).length)
    .toBeGreaterThan(150)
  await page.evaluate((id) => window.jiwei.plan.icsRefresh(id), f.id)
  expect(calendarRequests.at(-1)).toBe('recurring-v1')
  const last = (
    await sql('SELECT id,start_at FROM plan_events WHERE feed_id=? AND deleted_at IS NULL ORDER BY start_at DESC LIMIT 1', [f.id], true)
  )[0]
  await sql('UPDATE plan_events SET deleted_at=? WHERE id=?', [Date.now(), last.id])
  await sql('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)', [`ics.expanded:${f.id}`, String(Date.now() - 86400000)])
  await page.evaluate((id) => window.jiwei.plan.icsRefresh(id), f.id)
  expect(calendarRequests.at(-1)).toBe('')
  expect(
    await sql('SELECT id FROM plan_events WHERE feed_id=? AND start_at=? AND deleted_at IS NULL', [f.id, last.start_at], true)
  ).toHaveLength(1)
})
