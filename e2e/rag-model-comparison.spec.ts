import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { launchRagApp } from './fixtures/ragApp'
import { runPairedEvaluation, askEvaluationModel, hashInput, type PairedCase } from './fixtures/ragPairedEval'
import { captureRagRequests, takeRagRequests, initialEvidence } from './fixtures/ragRequests'
import { askInApp } from './fixtures/ragChat'
import { estimateTokens } from '../src/main/lib/sourceContext'
import { evaluationModels } from './fixtures/ragModels'
import type { RagQuestion, ScoredQuestion } from './fixtures/ragMetrics'

test.skip(process.env.JIWEI_RAG_PAIRED !== '1', '双回答模型真实对照，默认关闭')
test.describe.configure({ mode: 'serial' })
const root = process.env.JIWEI_RAG_EVAL ? resolve(process.env.JIWEI_RAG_EVAL) : ''
const group = process.env.JIWEI_RAG_PAIR_GROUP ?? 'baseline'
const output = process.env.JIWEI_RAG_PAIR_OUTPUT ? resolve(process.env.JIWEI_RAG_PAIR_OUTPUT) : ''
const load = <T>(name: string): T => JSON.parse(readFileSync(join(root, name), 'utf8')) as T
type Evidence = { number: number; title: string; heading?: string; text: string }
type E4Input = {
  cases: { question: RagQuestion; retrieved: Evidence[]; whole: Evidence[]; estimatedTokens: number }[]
  rubric: Record<string, string>
  datasetHash: string
}
let app: ElectronApplication, page: Page
test.beforeAll(async () => {
  for (const path of [root, output]) {
    const rel = relative(resolve('.'), path)
    if (!path || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('评测输入输出必须在仓库外')
  }
  if (!process.env.JIWEI_IMPORT_PROVIDERS_FROM) throw new Error('缺少已授权配置来源')
  const library = load<{ userData: string }>(process.env.JIWEI_RAG_LIBRARY_FILE ?? 'library-p6-ocr.json')
  if (!resolve(library.userData).startsWith(resolve(tmpdir()) + '/')) throw new Error('只能使用隔离评测库')
  app = await launchRagApp(
    group === 'E4' ? mkdtempSync(join(tmpdir(), 'rag-two-model-e4-')) : library.userData,
    process.env.JIWEI_IMPORT_PROVIDERS_FROM
  )
  const event = (name: string) =>
    appendFileSync(output + '.events.jsonl', JSON.stringify({ at: new Date().toISOString(), event: name }) + '\n')
  app.on('close', () => event('application-closed'))
  page = await app.firstWindow()
  page.on('crash', () => event('renderer-crashed'))
  page.on('close', () => event('page-closed'))
  await page.waitForSelector('nav')
  await captureRagRequests(app)
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({
      ai: {
        ...s.ai,
        embedding: { ...s.ai.embedding, mode: 'local' },
        recognition: { mode: 'off', auto: false, figures: false, providerId: null, model: null }
      },
      retrieval: { autoUpgrade: false }
    })
    for (const j of await window.jiwei.jobs.list())
      if (j.kind === 'source.recognize' && ['queued', 'running'].includes(j.status)) await window.jiwei.jobs.cancel(j.id)
  })
  if (['baseline', 'live', 'E5'].includes(group)) await page.evaluate(() => window.jiwei.embedding.installLocal())
})
test.afterAll(async () => {
  await app?.close()
})

async function nativeAnswer(c: PairedCase, target: Awaited<ReturnType<typeof evaluationModels>>['answers'][number]) {
  const scope = c.scope ?? { type: 'all' as const }
  let conversationId: string | undefined
  if (c.question.prev)
    conversationId = (
      await askInApp(page, { providerId: target.providerId, model: target.model, text: c.question.prev, scope, incognito: true })
    ).conversationId
  await takeRagRequests(app)
  const started = performance.now()
  const answer = await askInApp(page, {
    providerId: target.providerId,
    model: target.model,
    text: c.prompt,
    scope,
    conversationId,
    incognito: true
  })
  const answerMs = performance.now() - started,
    requests = await takeRagRequests(app)
  const provided = []
  for (const citation of answer.message.citations) {
    const segment =
      citation.parentType === 'source'
        ? (await page.evaluate((id) => window.jiwei.segments.list(id), citation.parentId)).find((g) => g.id === citation.ownerId)
        : null
    provided.push({ number: citation.n, title: citation.title, text: segment?.text ?? citation.snippet })
  }
  return {
    message: answer.message,
    requests,
    answerMs,
    evidenceHash: hashInput(initialEvidence(requests)),
    judgeEvidence: { provided, reference: c.question.gold, actualCitationCount: provided.length }
  }
}

test('inventory long source budgets for E5 without rerunning retrieval metrics', async () => {
  test.skip(group !== 'inventory')
  test.setTimeout(120000)
  const sources = await page.evaluate(() => window.jiwei.sources.list({})),
    rows = []
  for (const source of sources) {
    const segments = await page.evaluate((id) => window.jiwei.segments.list(id), source.id)
    rows.push({
      id: source.id,
      title: source.title,
      kind: source.kind,
      segments: segments.length,
      chars: segments.reduce((n, g) => n + g.text.length, 0),
      tokens: segments.reduce((n, g) => n + estimateTokens(g.text), 0),
      recognition: await page.evaluate((id) => window.jiwei.recognition.source(id), source.id)
    })
  }
  const targets = await evaluationModels(page)
  writeFileSync(
    output,
    JSON.stringify({ date: new Date().toISOString(), targets, rows: rows.sort((a, b) => b.tokens - a.tokens) }, null, 2)
  )
  console.log(
    JSON.stringify({
      sources: rows.length,
      maxTokens: Math.max(...rows.map((r) => r.tokens)),
      over60K: rows.filter((r) => r.tokens > 60000).length,
      over200K: rows.filter((r) => r.tokens > 200000).length,
      targets
    })
  )
})

test('same 80 questions through automatic RAG with identical initial evidence for both answer models', async () => {
  test.skip(group !== 'baseline')
  test.setTimeout(7_200_000)
  const data = load<{ rubric: Record<string, string>; questions: RagQuestion[] }>('answers.json')
  const library = load<{ result: string }>(process.env.JIWEI_RAG_LIBRARY_FILE ?? 'library-p6-ocr.json')
  const retrieval = load<{ rows: ScoredQuestion[] }>('results/' + library.result)
  const sources = await page.evaluate(() => window.jiwei.sources.list({}))
  const notes = await page.evaluate(() => window.jiwei.notes.list({ limit: 1000 }))
  const states = await page.evaluate(
    (ids) => window.jiwei.sources.readiness(ids),
    sources.map((s) => s.id)
  )
  const cases: PairedCase[] = data.questions.map((q) => {
    const row = retrieval.rows.find((r) => r.id === q.id)
    if (!row) throw new Error('固定检索结果缺少题目')
    const evidence = row.hits8.map((h, i) => ({ number: i + 1, title: h.title, heading: h.heading, locator: h.locator, text: h.text }))
    const involved = sources.filter(
      (s) => q.scope?.some((t) => s.title.includes(t)) || row.hits8.some((h) => h.parentType === 'source' && h.parentId === s.id)
    )
    const statuses = involved
      .filter((s) => states[s.id] && states[s.id].state !== 'ready')
      .slice(0, 5)
      .map((s) => ({ title: s.title, readiness: states[s.id] }))
    const scope = q.scope?.length
      ? {
          type: 'items' as const,
          sources: sources.filter((s) => q.scope!.some((t) => s.title.includes(t))).map((s) => s.id),
          notes: notes.filter((n) => q.scope!.some((t) => n.title.includes(t))).map((n) => n.id)
        }
      : { type: 'all' as const }
    return {
      id: q.id,
      group: 'baseline',
      question: q,
      prompt: q.q,
      native: true,
      scope,
      evidence: { provided: evidence },
      statuses,
      rubric: data.rubric
    }
  })
  expect(cases).toHaveLength(80)
  await runPairedEvaluation(page, cases, output, process.env.JIWEI_RAG_PAIR_RESUME, [], nativeAnswer)
})

test('E4 same 20 paired retrieved and whole-source cases for both answer models', async () => {
  test.skip(group !== 'E4')
  test.setTimeout(7_200_000)
  const data = load<E4Input>('experiments/E4-input.json')
  expect(data.cases).toHaveLength(20)
  const cases: PairedCase[] = data.cases.flatMap((c, i) =>
    (i % 2 ? ['whole', 'retrieved'] : ['retrieved', 'whole']).map((g) => {
      const evidence = g === 'whole' ? c.whole : c.retrieved
      return {
        id: c.question.id,
        group: 'E4-' + g,
        question: c.question,
        rubric: data.rubric,
        prompt: `请只根据以下编号资料回答问题，引用支持回答的具体编号，如[1]。资料中没有的信息请如实说明。不要调用工具，不要使用组件，直接用文字回答。\n问题：${c.question.q}\n<source-data>${JSON.stringify(evidence)}</source-data>`,
        evidence: { provided: g === 'whole' ? 'whole-reference' : evidence, reference: c.whole }
      }
    })
  )
  await runPairedEvaluation(page, cases, output, process.env.JIWEI_RAG_PAIR_RESUME)
})

test('E5 native selected-source questions at one of four common source budgets', async () => {
  test.skip(group !== 'E5')
  test.setTimeout(7_200_000)
  const data = load<{
    cases: { question: RagQuestion; sourceIds: string[]; tokens: number; tier: string }[]
    rubric: Record<string, string>
    datasetHash: string
  }>('experiments/E5-input.json')
  const ceiling = process.env.JIWEI_RAG_FULL_SOURCE_MAX_TOKENS
  expect(['0', '60000', '200000', 'window40']).toContain(ceiling)
  const cases: PairedCase[] = data.cases.map((c) => ({
    id: c.question.id,
    group: 'E5-' + ceiling,
    question: c.question,
    prompt: c.question.q,
    scope: { type: 'items', sources: c.sourceIds, notes: [] },
    native: true,
    evidence: { reference: c.question.gold, sourceTokens: c.tokens, tier: c.tier, datasetHash: data.datasetHash },
    rubric: data.rubric
  }))
  await runPairedEvaluation(page, cases, output, process.env.JIWEI_RAG_PAIR_RESUME, [], nativeAnswer)
})

test('real automatic RAG tool calls and clickable citations are recorded for both models', async () => {
  test.skip(group !== 'live')
  test.setTimeout(900_000)
  const sources = await page.evaluate(() => window.jiwei.sources.list({})),
    data = load<E4Input>('experiments/E4-input.json')
  const selected = data.cases.find(
    (c) =>
      c.estimatedTokens < 2500 &&
      c.question.scope?.length === 1 &&
      sources.some((s) => s.kind === 'document' && c.question.scope!.some((t) => s.title.includes(t)))
  )
  expect(selected).toBeTruthy()
  const ids = sources.filter((s) => selected!.question.scope!.some((t) => s.title.includes(t))).map((s) => s.id)
  const targets = await evaluationModels(page),
    rows = []
  await page.evaluate(async () => {
    const s = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ ai: { ...s.ai, embedding: { ...s.ai.embedding, mode: 'local' } } })
    await window.jiwei.embedding.installLocal()
  })
  for (const target of targets.answers) {
    await takeRagRequests(app)
    const response = await askEvaluationModel(
      page,
      target,
      selected!.question.q + '\n请先用 knowledge_search 查找相关证据，再用文字引用编号回答。',
      ids
    )
    let clickable = false
    if (response.message.status === 'done' && response.message.citations.length)
      try {
        const conversation = await page.evaluate((id) => window.jiwei.chat.get(id), response.conversationId)
        await page
          .getByTestId('nav-rail')
          .getByRole('button', { name: /^积微助手/ })
          .first()
          .click()
        await page.getByText(conversation!.title, { exact: true }).first().click()
        await page.locator('.cite-chip').first().click()
        await page.locator('.source-text .is-flash').first().waitFor({ state: 'visible', timeout: 10000 })
        clickable = true
      } catch {
        /* 原样记录，交人工裁定，不为某个模型改变引用或工具格式。 */
      }
    const requests = await takeRagRequests(app)
    expect(requests.length).toBeGreaterThan(0)
    rows.push({
      modelKey: target.key,
      model: target.model,
      response,
      clickable,
      requests,
      evidenceHash: hashInput(initialEvidence(requests))
    })
    writeFileSync(output, JSON.stringify({ mode: 'real-automatic-RAG', sameSelectedSourceIds: ids, rows }, null, 2))
  }
  expect(rows).toHaveLength(2)
  expect(new Set(rows.map((r) => r.evidenceHash)).size).toBe(1)
})
