import { expect, it } from 'vitest'
import { summarizeAnswerModels, type AnswerEvaluationRow } from './ragAnswerMetrics'

const rows: AnswerEvaluationRow[] = ['a', 'b'].flatMap((modelKey) =>
  Array.from({ length: 4 }, (_, i) => ({
    id: String(i),
    modelKey,
    subtype: i < 2 ? 'fact' : 'none',
    expectNone: i >= 2,
    answerMs: (i + 1) * 1000,
    usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4, reasoningTokens: 0 },
    score: {
      correct: i % 2 === 0 || modelKey === 'b' ? 2 : 0,
      citations: i === 0 || modelKey === 'b' ? 2 : 0,
      honesty: i % 2 === 0 ? 2 : 0,
      refused: i === 2
    }
  }))
)

it('reports independent correctness, citation, refusal, latency and provider usage denominators', () => {
  const report = summarizeAnswerModels(rows)
  expect(report.byModel.a).toMatchObject({
    count: 4,
    graded: 4,
    correctRate: 0.5,
    citationRate: 0.5,
    refusalRate: 0.5,
    answerMsMean: 2500,
    usage: { reported: 4, missing: 0, inputTokens: 40, outputTokens: 8, cachedInputTokens: 16, inputTokensMean: 10 }
  })
  expect(report.byModel.b).toMatchObject({ correctRate: 1, citationRate: 1, refusalRate: 0.5 })
  expect(report.gapsOver10pp).toEqual([
    { subtype: 'fact', metric: 'correctRate', a: 0.5, b: 1, gap: 0.5 },
    { subtype: 'fact', metric: 'citationRate', a: 0.5, b: 1, gap: 0.5 },
    { subtype: 'none', metric: 'correctRate', a: 0.5, b: 1, gap: 0.5 }
  ])
})

it('does not turn missing judgements or unreported usage into a passing rate or zero tokens', () => {
  const report = summarizeAnswerModels([{ ...rows[0], score: null, usage: null }])
  expect(report.byModel.a).toMatchObject({
    graded: 0,
    correctRate: null,
    citationRate: null,
    refusalRate: null,
    usage: { reported: 0, missing: 1, inputTokensMean: null }
  })
})
