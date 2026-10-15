import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { hashInput, runPairedEvaluation, type PairedCase } from './ragPairedEval'
import type { ChatMessage } from '../../src/shared/types'

const state = vi.hoisted(() => ({ model: 'answer-model', judge: 'judge-model', answers: 0, grades: 0 }))
vi.mock('./ragModels', () => ({
  evaluationModels: async () => ({
    answers: [{ key: 'answer', providerId: 'provider', model: state.model, context: 65536, contextSource: 'builtin' }],
    judge: { key: 'judge', providerId: 'provider', model: state.judge, context: 65536, contextSource: 'builtin' }
  })
}))
vi.mock('./ragChat', () => ({
  askInApp: async () => ({
    conversationId: 'conversation',
    message: {
      id: 'original-' + ++state.answers,
      status: 'done',
      content: 'answer',
      citations: [],
      readiness: []
    } as unknown as ChatMessage
  }),
  UnsettledAnswerError: class extends Error {}
}))
vi.mock('./ragJudgeTransport', () => ({
  sendJudgement: async () => ({
    message: {
      id: 'grade-' + ++state.grades,
      status: 'done',
      content: '{"correct":2,"complete":2,"citations":2,"honesty":2,"refused":false,"reason":"synthetic"}'
    },
    transport: { kind: 'single-message', chars: 10, sha256: 'synthetic', preparations: [] }
  })
}))
let directory: string, output: string
const page = { isClosed: () => false } as unknown as Page
const makeCase = (): PairedCase =>
  ({
    id: 'q',
    group: 'fixed',
    question: { id: 'q', q: 'question', scenario: 'S1', subtype: 'fact', gated: 'test', gold: [{ title: 'source', quote: 'old gold' }] },
    prompt: 'same prompt',
    evidence: { reference: 'original reference' },
    rubric: { correct: 'original rubric' },
    dataVersion: { corpus: 'corpus-v1', retrieval: 'retrieval-v1', application: 'frozen-build' }
  }) as PairedCase
beforeEach(() => {
  state.model = 'answer-model'
  state.judge = 'judge-model'
  state.answers = 0
  state.grades = 0
  directory = mkdtempSync(join(tmpdir(), 'rag-resume-'))
  output = join(directory, 'result.json')
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

it('regrades changed gold, rubric and reference while preserving the completed original answer', async () => {
  const c = makeCase()
  await runPairedEvaluation(page, [c], output)
  c.question.gold![0].quote = 'new gold'
  c.rubric.correct = 'new rubric'
  c.evidence = { reference: 'new reference' }
  await runPairedEvaluation(page, [c], output, output)
  const d = JSON.parse(readFileSync(output, 'utf8'))
  expect(d.results[0].question.gold[0].quote).toBe('new gold')
  expect(d.results[0].answer.id).toBe('original-1')
  expect(d.results[0].gradingAttempts[0].score.correct).toBe(2)
  expect(d.results[0].gradingAttempts[0].error).toBeNull()
  expect(d.results[0].judgement.id).toBe('grade-2')
  expect([state.answers, state.grades]).toEqual([1, 2])
})

it.each(['model', 'corpus', 'retrieval', 'prompt'] as const)('rejects changed %s before rewriting or mixing the result', async (kind) => {
  const c = makeCase()
  await runPairedEvaluation(page, [c], output)
  const original = readFileSync(output, 'utf8')
  if (kind === 'model') state.model = 'changed-model'
  else if (kind === 'prompt') c.prompt = 'changed prompt'
  else (c as PairedCase & { dataVersion: Record<string, string> }).dataVersion[kind] = 'changed'
  await expect(runPairedEvaluation(page, [c], output, output)).rejects.toThrow(/恢复/)
  expect(readFileSync(output, 'utf8')).toBe(original)
  expect([state.answers, state.grades]).toEqual([1, 1])
})

it('changing the fixed judge invalidates only grading', async () => {
  const c = makeCase()
  await runPairedEvaluation(page, [c], output)
  state.judge = 'new-fixed-judge'
  const rows = await runPairedEvaluation(page, [c], output, output)
  expect(rows[0].judgement?.id).toBe('grade-2')
  expect([state.answers, state.grades]).toEqual([1, 2])
})

it('keeps raw grading while applying the specified zero baseline for unavailable source types', async () => {
  const c = makeCase()
  c.question.unavailable = 'unindexed-test-type'
  const rows = await runPairedEvaluation(page, [c], output)
  expect(rows[0].rawScore).toMatchObject({ correct: 2, complete: 2, citations: 2 })
  expect(rows[0].score).toMatchObject({ correct: 0, complete: 0, citations: 0, honesty: 2, total: 2 })
})

it('requires an exact legacy file digest and archives all old grades before importing original answers', async () => {
  const c = makeCase()
  await runPairedEvaluation(page, [c], output)
  const prior = JSON.parse(readFileSync(output, 'utf8'))
  delete prior.protocolVersion
  delete prior.results[0].gradingHash
  const text = JSON.stringify(prior),
    legacy = join(directory, 'legacy.json')
  writeFileSync(legacy, text)
  await expect(runPairedEvaluation(page, [c], output, legacy)).rejects.toThrow(/SHA256/)
  vi.stubEnv('JIWEI_RAG_LEGACY_RESUME_SHA256', hashInput(text))
  const rows = await runPairedEvaluation(page, [c], output, legacy)
  expect(rows[0].answer?.id).toBe('original-1')
  expect(rows[0].gradingAttempts).toHaveLength(1)
  expect(rows[0].gradingAttempts![0].score?.total).toBe(8)
  expect(rows[0].judgement?.id).toBe('grade-2')
  await runPairedEvaluation(page, [c], output, output)
  expect([state.answers, state.grades]).toEqual([1, 2])
})

it('grades complete numbered evidence actually sent to the model, retaining metadata and empty tool outcomes', async () => {
  const c = makeCase()
  c.native = true
  const requests = [
    {
      model: 'answer-model',
      toolNames: [],
      messages: [
        {
          role: 'user',
          content:
            '<知识库片段>\n[1] 资料《synthetic》 › heading（sourceId: source-id） · 片段 segment-id\nActual expanded source including TAIL.\n\n[2] 笔记《note》（noteId: note-id）· 学习于 2026 · 存疑\nFull note ending beyond the snippet.\n</知识库片段>'
        },
        { role: 'tool', content: '（没有检索到相关内容）' },
        { role: 'tool', content: '《source》共 2 段\n[other-id · block=2] Unnumbered source_read material' },
        { role: 'assistant', content: '[3] 资料《invented》（sourceId: other） · 片段 invented\nInvented assistant support.' }
      ]
    }
  ]
  const answer = {
    id: 'native',
    status: 'done',
    content: 'answer [1][2][3]',
    citations: [
      { n: 1, title: 'synthetic', parentType: 'source', parentId: 'source-id', ownerId: 'segment-id', snippet: 'short' },
      { n: 2, title: 'note', parentType: 'note', parentId: 'note-id', ownerId: 'note-block', snippet: 'short' },
      { n: 3, title: 'invented', parentType: 'source', parentId: 'other', ownerId: 'invented', snippet: 'invented' }
    ],
    steps: []
  } as unknown as ChatMessage
  const rows = await runPairedEvaluation(page, [c], output, undefined, [], async () => ({
    message: answer,
    requests,
    evidenceHash: 'same',
    answerMs: 25,
    judgeEvidence: { provided: 'obsolete snippet' }
  }))
  const evidence = rows[0].judgeEvidence as {
    provided: { text: string; header: string; number: number; missing?: boolean }[]
    toolObservations: unknown[]
  }
  expect(evidence.provided[0].text).toContain('including TAIL.')
  expect(evidence.provided[1].text).toContain('beyond the snippet.')
  expect(evidence.provided[1].header).toContain('存疑')
  expect(evidence.provided[2]).toMatchObject({ number: 3, missing: true })
  expect(JSON.stringify(evidence.toolObservations)).toContain('没有检索到相关内容')
  expect(evidence.provided[2].text).not.toContain('Invented assistant support')
})
