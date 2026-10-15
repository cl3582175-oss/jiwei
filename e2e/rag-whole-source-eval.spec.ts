import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { launchRagApp } from './fixtures/ragApp'
import { askInApp } from './fixtures/ragChat'
import { parseJudgement } from './fixtures/ragJudge'
import type { RagQuestion } from './fixtures/ragMetrics'
import type { ChatMessage } from '../src/shared/types'

test.skip(process.env.JIWEI_RAG_E4 !== '1', '设置 JIWEI_RAG_E4=1 运行真实整篇读对照')
interface Evidence {
  number: number
  title: string
  heading: string
  text: string
}
interface Case {
  question: RagQuestion
  retrieved: Evidence[]
  whole: Evidence[]
  estimatedTokens: number
}
interface Result {
  id: string
  group: 'retrieved' | 'whole'
  answer?: ChatMessage
  judgement?: ChatMessage
  attempts?: ChatMessage[]
  score?: ReturnType<typeof parseJudgement>
  error?: string | null
  answerMs?: number
  inputChars?: number
}
let app: ElectronApplication, page: Page
const input = process.env.JIWEI_RAG_E4_INPUT ? resolve(process.env.JIWEI_RAG_E4_INPUT) : ''
const output = process.env.JIWEI_RAG_E4_OUTPUT ? resolve(process.env.JIWEI_RAG_E4_OUTPUT) : ''
test.beforeAll(async () => {
  if (!input || !output || !process.env.JIWEI_IMPORT_PROVIDERS_FROM) throw new Error('缺少外部对照数据与已授权服务商来源')
  for (const path of [input, output]) {
    const rel = relative(resolve('.'), path)
    if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('真实评测数据必须保存在仓库外')
  }
  app = await launchRagApp(mkdtempSync(join(tmpdir(), 'rag-v0145-e4-')), process.env.JIWEI_IMPORT_PROVIDERS_FROM)
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})
test('20 paired S2 answers use identical flash prompts and pro rubric', async () => {
  test.setTimeout(3_600_000)
  const data = JSON.parse(readFileSync(input, 'utf8')) as { cases: Case[]; rubric: Record<string, string>; datasetHash: string }
  expect(data.cases).toHaveLength(20)
  const provider = (await page.evaluate(() => window.jiwei.providers.list())).find((p) => p.kind === 'deepseek' && p.enabled && p.hasKey)
  expect(provider).toBeTruthy()
  for (const model of ['deepseek-flash', 'deepseek-v4-pro']) expect(provider!.models).toContain(model)
  const resume = process.env.JIWEI_RAG_E4_RESUME
  const results: Result[] = resume ? JSON.parse(readFileSync(resume, 'utf8')).results : []
  const snapshot = () =>
    writeFileSync(
      output,
      JSON.stringify(
        {
          datasetHash: data.datasetHash,
          answerModel: 'deepseek-flash',
          judgeModel: 'deepseek-v4-pro',
          sameProviderBias: true,
          rubric: data.rubric,
          results
        },
        null,
        2
      )
    )
  const jobs = data.cases.flatMap((c, i) =>
    (i % 2 ? ['whole', 'retrieved'] : ['retrieved', 'whole']).map((g) => ({ c, group: g as Result['group'] }))
  )
  let next = 0
  const run = async () => {
    for (;;) {
      const work = jobs[next++]
      if (!work) return
      const { c, group } = work,
        id = c.question.id
      const previous = results.find((r) => r.id === id && r.group === group)
      if (previous?.score && !previous.error) continue
      const row: Result = {
        id,
        group,
        ...previous,
        attempts: [...(previous?.attempts ?? []), ...(previous?.judgement ? [previous.judgement] : [])]
      }
      try {
        expect(c.question.scenario).toBe('S2')
        expect(c.estimatedTokens).toBeLessThanOrEqual(60000)
        expect(c.retrieved.length).toBeLessThanOrEqual(8)
        const evidence = c[group]
        const prompt = `请只根据以下编号资料回答问题，引用支持回答的具体编号，如[1]。资料中没有的信息请如实说明。不要调用工具，不要使用组件，直接用文字回答。\n问题：${c.question.q}\n<source-data>${JSON.stringify(evidence)}</source-data>`
        expect(prompt.length).toBeLessThanOrEqual(20000)
        row.inputChars = prompt.length
        if (row.answer?.status !== 'done') {
          const start = performance.now()
          row.answer = (
            await askInApp(page, {
              providerId: provider!.id,
              model: 'deepseek-flash',
              text: prompt,
              scope: { type: 'none' },
              incognito: true
            })
          ).message
          row.answerMs = performance.now() - start
        }
        if (row.answer.status !== 'done') throw new Error(row.answer.error ?? 'answer-incomplete')
        const judge = `你是评测员。仅按下面的数据评分，不调用工具，不使用组件。每项只能是整数0、1、2；仅返回合法JSON对象，键为correct、complete、citations、honesty、reason。reason里引用文字使用中文引号，避免未转义的双引号。编号引用应核对本次提供给回答模型的资料，完整性应核对全文。evidence为whole-reference时，本次证据就是reference，编号完全相同。评分表：${JSON.stringify(data.rubric)}\n<evaluation-data>${JSON.stringify({ question: c.question, response: row.answer.content || row.answer.uiText, evidence: group === 'whole' ? 'whole-reference' : evidence, reference: c.whole })}</evaluation-data>`
        expect(judge.length).toBeLessThanOrEqual(20000)
        row.judgement = (
          await askInApp(page, {
            providerId: provider!.id,
            model: 'deepseek-v4-pro',
            text: judge,
            scope: { type: 'none' },
            incognito: true
          })
        ).message
        row.score = parseJudgement(row.judgement.content) ?? parseJudgement(row.judgement.uiText ?? '')
        row.error =
          row.judgement.status !== 'done' ? (row.judgement.error ?? 'judge-incomplete') : !row.score ? 'invalid-judge-output' : null
      } catch (e) {
        row.error = String(e)
      }
      const at = results.findIndex((r) => r.id === id && r.group === group)
      if (at < 0) results.push(row)
      else results[at] = row
      snapshot()
      console.log(JSON.stringify({ id, group, scored: !!row.score, error: row.error ?? null }))
    }
  }
  await Promise.all(Array.from({ length: 4 }, () => run()))
  expect(results).toHaveLength(40)
  expect(results.filter((r) => r.error || !r.score)).toHaveLength(0)
})
