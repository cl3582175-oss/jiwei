import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import Database from 'better-sqlite3'
import * as Y from 'yjs'
import type { ContextPacket } from '../src/shared/context'
import { DOC_FIELD } from '../src/shared/types'
import { UI_EVAL, type UiEvalCase } from './fixtures/uiEval'
import {
  analyzeAnswer,
  automaticEligibility,
  evalMarkdown,
  finalizeComponents,
  parseReviews,
  summarizeEval,
  type EvalResult,
  type Reviews
} from './fixtures/uiEvalMetrics'

test.skip(process.env.JIWEI_EVAL !== '1', '仅 JIWEI_EVAL=1 时运行智能界面评测')
test.describe.configure({ mode: 'serial' })
const controlled = process.env.JIWEI_EVAL_FAKE === '1'
let app: ElectronApplication, page: Page, server: Server | undefined, db: Database.Database
let profile = '',
  providerId = '',
  model = '',
  response = ''
const results: EvalResult[] = []
const requests: { role: string; content: unknown }[][] = []
const corpusSha256 = createHash('sha256')
  .update(readFileSync(resolve('e2e/fixtures/uiEval.ts')))
  .digest('hex')
const reviews: Reviews = process.env.JIWEI_EVAL_REVIEW ? parseReviews(JSON.parse(readFileSync(process.env.JIWEI_EVAL_REVIEW, 'utf8'))) : {}
const reportPath = resolve('test-results/ui-eval.md')

function within(parent: string, path: string): boolean {
  const r = relative(parent, path)
  return r !== '' && !isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`)
}
function safeProfile(path: string): string {
  const root = realpathSync(path)
  if (!within(realpathSync(tmpdir()), root)) throw new Error('JIWEI_EVAL_USER_DATA_DIR 必须是 os.tmpdir() 下独立的临时目录')
  const config = join(root, 'jiwei-config.json')
  if (existsSync(config)) {
    const boot = JSON.parse(readFileSync(config, 'utf8')) as { dataDir?: string; pendingBackup?: string; vaults?: { path: string }[] }
    for (const value of [boot.dataDir, boot.pendingBackup, ...(boot.vaults ?? []).map((v) => v.path)])
      if (value && !within(root, realpathSync(value))) throw new Error('临时配置不得指向目录外的知识库或恢复文件')
  }
  return root
}
function saveReport(): void {
  mkdirSync(resolve('test-results'), { recursive: true })
  const metadata = { mode: controlled ? ('controlled' as const) : ('real' as const), model, planned: UI_EVAL.length, corpusSha256 }
  writeFileSync(reportPath, evalMarkdown(results, reviews, metadata))
  writeFileSync(
    resolve('test-results/ui-eval.json'),
    JSON.stringify({ metadata, metrics: summarizeEval(results, reviews), results }, null, 2)
  )
  writeFileSync(
    resolve('test-results/ui-eval-review-template.json'),
    JSON.stringify(
      Object.fromEntries(
        UI_EVAL.map((q) => [
          q.id,
          {
            selectionScore: null,
            fabricatedData: null,
            unauthorizedRendering: null,
            notes: ''
          }
        ])
      ),
      null,
      2
    )
  )
}

test.beforeAll(async () => {
  profile = safeProfile(controlled ? mkdtempSync(join(tmpdir(), 'jiwei-ui-eval-')) : (process.env.JIWEI_EVAL_USER_DATA_DIR ?? ''))
  if (!controlled && !process.env.JIWEI_EVAL_PROVIDER) throw new Error('真实评测需要 JIWEI_EVAL_PROVIDER 和已配置的临时 user-data-dir')
  if (controlled) {
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        const input = JSON.parse(body || '{}')
        requests.push(input.messages ?? [])
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        let offset = 0
        // 此脚本验证问题循环和统计；20ms 的真实流式观测由 intelligent-ui.spec 覆盖。
        const timer = setInterval(() => {
          const content = response.slice(offset, offset + 10)
          const last = offset >= response.length
          res.write(
            `data: ${JSON.stringify({ id: 'eval', object: 'chat.completion.chunk', created: 1, model: 'controlled-ui', choices: [{ index: 0, delta: last ? {} : { content }, finish_reason: last ? 'stop' : null }] })}\n\n`
          )
          offset += 10
          if (last) {
            clearInterval(timer)
            res.end('data: [DONE]\n\n')
          }
        }, 2)
        res.on('close', () => clearInterval(timer))
      })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  }
  app = await electron.launch({
    args: ['.', `--user-data-dir=${profile}`],
    env: {
      ...process.env,
      JIWEI_LANG: 'zh-CN',
      JIWEI_SKIP_ONBOARDING: '1',
      // 真实模式：Playwright 默认注入 --use-mock-keychain，临时配置里手动保存的密钥解不开。
      // 用现有测试导入（只复制服务商表与 AI 设置，密钥保持加密）并让应用移除 mock keychain。
      JIWEI_IMPORT_PROVIDERS_FROM: controlled ? '' : (process.env.JIWEI_EVAL_PROVIDERS_FROM ?? ''),
      JIWEI_TEST_NETWORK: controlled ? '1' : '',
      JIWEI_TEST_UI_FULL: controlled ? '1' : ''
    }
  })
  page = await app.firstWindow()
  await page.waitForSelector('nav')
  const info = await page.evaluate(() => window.jiwei.app.info())
  if (!within(profile, realpathSync(info.dataDir))) throw new Error('应用知识库必须位于指定临时 user-data-dir 内')
  db = new Database(join(info.dataDir, 'jiwei.db'), { fileMustExist: true })
  for (const table of ['notes', 'sources', 'actions', 'decisions'])
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`).get() as { n: number }).n,
      '评测配置只能含服务商，不能含既有用户资料'
    ).toBe(0)
  await page.evaluate(() => window.jiwei.memory.setSettings({ autoLearn: false, learnSkills: false }))
  if (controlled) {
    model = 'controlled-ui'
    providerId = await page.evaluate(
      async (baseUrl) =>
        (await window.jiwei.providers.save({ kind: 'ollama', name: '智能界面评测假服务器', baseUrl, models: ['controlled-ui'] })).id,
      `http://127.0.0.1:${(server!.address() as { port: number }).port}/v1`
    )
  } else {
    providerId = process.env.JIWEI_EVAL_PROVIDER!
    const providers = await page.evaluate(() => window.jiwei.providers.list())
    const provider = providers.find((p) => p.id === providerId)
    if (!provider?.enabled) throw new Error('指定的临时服务商未配置或已关闭')
    const settings = await page.evaluate(() => window.jiwei.settings.get())
    model =
      process.env.JIWEI_EVAL_MODEL ??
      (settings.ai.chat.providerId === providerId ? settings.ai.chat.model : null) ??
      provider.models[0] ??
      ''
    if (!model || !provider.models.includes(model)) throw new Error('请在临时配置中选择有效模型，或指定 JIWEI_EVAL_MODEL')
  }
  await page.evaluate(
    async ({ providerId, model, controlled }) => {
      const s = await window.jiwei.settings.get()
      await window.jiwei.settings.set({
        ai: {
          ...s.ai,
          chat: { providerId, model },
          effort: 'off',
          ui: { ...s.ai.ui, density: 'normal', localModels: controlled ? 'normal' : s.ai.ui.localModels }
        },
        retrieval: { ...s.retrieval, mode: 'off' }
      })
    },
    { providerId, model, controlled }
  )
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
})
test.afterAll(async () => {
  saveReport()
  await test.info().attach('智能界面评测', { path: reportPath, contentType: 'text/markdown' })
  db?.close()
  await app?.close()
  if (server) await new Promise<void>((r) => server!.close(() => r()))
})

const auditTables = [
  'notes',
  'note_updates',
  'proposals',
  'actions',
  'plan_events',
  'cards',
  'review_logs',
  'mistakes',
  'decisions',
  'goals',
  'works'
]
function audit(): Record<string, string> {
  return Object.fromEntries(auditTables.map((table) => [table, JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())]))
}
async function seed(q: UiEvalCase): Promise<{ ids: Record<string, string>; context: ContextPacket; clean(): Promise<void> }> {
  const p = q.preset,
    ids: Record<string, string> = {},
    context: ContextPacket = { targets: [] },
    events: string[] = [],
    tasks: string[] = []
  if (p) {
    for (const e of p.events)
      events.push(
        await page.evaluate(
          async (e) =>
            (
              await window.jiwei.plan.eventSave({
                kind: 'event',
                title: e.title,
                startAt: new Date(e.start).getTime(),
                endAt: new Date(e.end).getTime()
              })
            ).id,
          e
        )
      )
    for (const a of p.tasks)
      tasks.push(
        await page.evaluate(
          async (a) => (await window.jiwei.actions.create(a.title, a.due ? new Date(a.due + 'T12:00').getTime() : null)).id,
          a
        )
      )
    if (p.noteTitle || p.review.length || q.acceptableTypes.some((t) => ['note', 'mastery'].includes(t))) {
      ids.note = await page.evaluate(async (title) => (await window.jiwei.notes.create({ title })).id, p.noteTitle ?? `评测笔记 ${q.id}`)
      context.noteId = ids.note
      if (p.review.length) {
        const state = await page.evaluate((id) => window.jiwei.notes.loadDoc(id).then((s) => Array.from(s)), ids.note)
        const doc = new Y.Doc()
        Y.applyUpdate(doc, Uint8Array.from(state))
        const before = Y.encodeStateVector(doc),
          frag = doc.getXmlFragment(DOC_FIELD)
        const para = (text: string): Y.XmlElement => {
          const e = new Y.XmlElement('paragraph')
          e.setAttribute('id', randomUUID())
          const t = new Y.XmlText()
          t.insert(0, text)
          e.insert(0, [t])
          return e
        }
        frag.insert(
          0,
          p.review.map((card) => {
            const row = new Y.XmlElement('cornellRow')
            row.setAttribute('id', randomUUID())
            const cue = new Y.XmlElement('cornellCue'),
              body = new Y.XmlElement('cornellBody')
            cue.insert(0, [para(card.cue)])
            body.insert(0, [para(card.body)])
            row.insert(0, [cue, body])
            return row
          })
        )
        const update = Array.from(Y.encodeStateAsUpdate(doc, before))
        doc.destroy()
        await page.evaluate(({ id, update }) => window.jiwei.notes.pushUpdate(id, Uint8Array.from(update)), { id: ids.note, update })
        await expect
          .poll(() =>
            page.evaluate(
              (id) => window.jiwei.notes.blocks(id).then((bs) => bs.filter((b) => b.section === 'cue' && b.text).length),
              ids.note
            )
          )
          .toBe(p.review.length)
        const cards = await page.evaluate((id) => window.jiwei.review.forNote(id), ids.note)
        for (let i = 0; i < p.review.length; i++)
          if (p.review[i].rating)
            await page.evaluate(({ id, rating }) => window.jiwei.review.rate(id, rating), { id: cards[i].id, rating: p.review[i].rating! })
      }
    }
    if (p.decision) {
      ids.decision = randomUUID()
      const memo = {
        restated: p.decision.question,
        options: p.decision.options.map((title, i) => ({ id: `O${i}`, title, summary: '' })),
        criteria: [
          { name: '适合程度', weight: 4, why: '' },
          { name: '实施成本', weight: 3, why: '' }
        ],
        scores: p.decision.options.flatMap((_, i) => [
          { option: `O${i}`, criterion: '适合程度', score: i ? 3 : 4, why: '' },
          { option: `O${i}`, criterion: '实施成本', score: i ? 4 : 3, why: '' }
        ]),
        evidence: [],
        assumptions: [],
        premortem: [],
        secondOrder: [],
        counter: '',
        risks: [],
        recommendation: { option: 'O0', why: '评测预置' },
        confidence: 3,
        unknowns: []
      }
      db.prepare('INSERT INTO decisions (id,question,memo,created_at,updated_at) VALUES (?,?,?,?,?)').run(
        ids.decision,
        p.decision.question,
        JSON.stringify(memo),
        Date.now(),
        Date.now()
      )
    }
  }
  const external = q.external ?? p?.excerpt
  if (external) {
    const path = join(profile, `${q.id}.md`)
    writeFileSync(path, `# 评测资料 ${q.id}\n\n${external}`)
    ids.source = await page.evaluate(async (path) => (await window.jiwei.sources.importPaths([path])).imported[0].id, path)
    await expect.poll(() => page.evaluate((id) => window.jiwei.segments.list(id).then((ss) => ss.length), ids.source)).toBeGreaterThan(0)
    ids.segment = await page.evaluate(
      async ({ id, external }) => {
        const first = (await window.jiwei.segments.list(id))[0]
        await window.jiwei.segments.update(first.id, external)
        return first.id
      },
      { id: ids.source, external }
    )
    context.targets.push({ kind: 'source-text', parentType: 'source', parentId: ids.source, ownerId: ids.segment, quote: external })
  }
  return {
    ids,
    context,
    clean: async () => {
      for (const id of events) await page.evaluate((id) => window.jiwei.plan.eventRemove(id), id)
      for (const id of tasks) await page.evaluate((id) => window.jiwei.actions.remove(id), id)
      if (ids.note) await page.evaluate((id) => window.jiwei.notes.trash(id), ids.note)
      if (ids.source) await page.evaluate((id) => window.jiwei.sources.trash(id), ids.source)
      if (ids.decision) await page.evaluate((id) => window.jiwei.advisor.remove(id), ids.decision)
    }
  }
}

for (const q of UI_EVAL)
  test(`${q.id} ${q.group} ${q.prompt}`, async () => {
    test.setTimeout(controlled ? 30_000 : 120_000)
    const prepared = await seed(q),
      before = audit(),
      result: EvalResult = {
        id: q.id,
        group: q.group,
        prompt: q.prompt,
        expectedUse: q.expectedUse,
        acceptableTypes: q.acceptableTypes,
        preset: q.preset,
        turns: [],
        unauthorizedWrites: 0
      }
    results.push(result)
    let conversationId: string | null = null,
      messageId = ''
    try {
      const replaceIds = (text: string): string =>
        text.replace(/\$(note|segment|decision)/g, (_, key: string) => prepared.ids[key] ?? `missing-${key}`)
      const idContext = Object.entries(prepared.ids)
        .filter(([key]) => key !== 'source')
        .map(([key, id]) => `${key} ID=${id}`)
        .join('\n')
      const turns = [
        { text: q.prompt + (idContext ? '\n\n' + idContext : ''), answer: q.controlledAnswer },
        ...(q.followup ? [q.followup] : [])
      ]
      for (const [i, turn] of turns.entries()) {
        response = replaceIds(turn.answer)
        const sent = await page.evaluate(
          ({ text, conversationId, providerId, model, context, event }) =>
            window.jiwei.chat.send({
              conversationId,
              text,
              providerId,
              model,
              effort: 'off',
              scope: { type: 'none' },
              web: 'off',
              context,
              ...(event ? { uiEvent: event } : {})
            }),
          {
            text: turn.text,
            conversationId,
            providerId,
            model,
            context: prepared.context,
            event:
              i && q.followup?.action
                ? {
                    messageId,
                    componentId: 'b0',
                    type: result.turns[0].components[0]?.type ?? 'choice',
                    action: q.followup.action,
                    value: q.followup.value
                  }
                : null
          }
        )
        conversationId = sent.conversation.id
        messageId = sent.assistantMessageId
        await app.evaluate(
          ({ BrowserWindow }, id) => BrowserWindow.getAllWindows()[0].webContents.send('event:nav:chat', { conversationId: id }),
          conversationId
        )
        // 真实模型首包可能超过 5 秒，界面在开始流式时才刷新出这条用户消息
        await expect(page.locator('main .paper.whitespace-pre-wrap').last()).toHaveText(turn.text, { timeout: controlled ? 5_000 : 30_000 })
        await expect
          .poll(
            () =>
              page.evaluate(({ c, m }) => window.jiwei.chat.messages(c).then((ms) => ms.find((x) => x.id === m)?.status), {
                c: conversationId!,
                m: messageId
              }),
            { timeout: controlled ? 15_000 : 90_000 }
          )
          .not.toBe('streaming')
        const message = await page.evaluate(({ c, m }) => window.jiwei.chat.messages(c).then((ms) => ms.find((x) => x.id === m)!), {
          c: conversationId,
          m: messageId
        })
        const components = analyzeAnswer(message.content)
        if (components.length) await expect(page.getByTestId('ui-block').last()).not.toHaveAttribute('data-ui-state', 'streaming')
        if (components.some((c) => c.type === 'diagram' && c.valid))
          await expect(
            page.locator('.chat-md').last().locator('.diagram-svg svg, [data-ui-type="diagram"][data-ui-state="fallback"]').first()
          ).toBeVisible()
        await expect(page.locator('.chat-md').last()).not.toContainText('正在读取…')
        const rendered = await page
          .locator('.chat-md')
          .last()
          .getByTestId('ui-block')
          .evaluateAll((els) =>
            els.map((el) => ({
              type: el.getAttribute('data-ui-type'),
              state: el.getAttribute('data-ui-state'),
              text: el.textContent ?? ''
            }))
          )
        result.turns.push({
          prompt: turn.text,
          answer: message.content,
          status: message.status,
          components: finalizeComponents(components, rendered),
          rendered
        })
        if (controlled) expect(message.content).toBe(response)
      }
      const after = audit()
      result.unauthorizedWrites = auditTables.filter((table) => before[table] !== after[table]).length
      await page.screenshot({ path: test.info().outputPath(`${q.id}.png`) })
      await test.info().attach('逐题结果', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
      if (controlled) expect(automaticEligibility(result), q.id).toBe(true)
    } finally {
      if (messageId) await page.evaluate((id) => window.jiwei.chat.stop(id), messageId)
      saveReport()
      if (conversationId) await page.evaluate((id) => window.jiwei.chat.remove(id), conversationId)
      await prepared.clean()
      // 保持长评测中的临时目录活跃，避免下一次清理把待审证据作为陈旧目录处理。
      utimesSync(profile, new Date(), new Date())
    }
  })

test('受控统计与实际请求边界', async () => {
  expect(results).toHaveLength(120)
  if (!controlled) return
  const metrics = summarizeEval(results, {})
  expect(metrics.specificity.value).toBe(1)
  expect(metrics.recall.value).toBe(1)
  expect(metrics.validation.value).toBe(1)
  expect(metrics.selection.value).toBeNull()
  expect(metrics.fabrication.value).toBeNull()
  expect(metrics.adversarial.value).toBeNull()
  expect(requests.length).toBeGreaterThanOrEqual(130)
  for (const request of requests) {
    const text = JSON.stringify(request)
    expect(text).not.toContain('controlledAnswer')
    expect(text).not.toContain('acceptableTypes')
  }
})
