import type { Usage } from '../../src/shared/ai'

export interface AnswerEvaluationRow {
  id: string
  modelKey: string
  subtype: string
  expectNone: boolean
  answerMs?: number
  usage?: Usage | null
  score?: { correct: number; citations: number; honesty: number; total?: number; refused?: boolean | null } | null
}
function metrics(rows: AnswerEvaluationRow[]) {
  const graded = rows.filter((r) => r.score),
    citations = rows.filter((r) => !r.expectNone),
    none = rows.filter((r) => r.expectNone)
  const rate = (group: AnswerEvaluationRow[], pass: (r: AnswerEvaluationRow) => boolean): number | null =>
    group.length && group.every((r) => r.score) ? group.filter(pass).length / group.length : null
  const timed = rows.filter((r) => typeof r.answerMs === 'number'),
    reported = rows.flatMap((r) => (r.usage ? [r.usage] : []))
  const sum = (key: keyof Usage) => reported.reduce((s, u) => s + u[key], 0)
  return {
    count: rows.length,
    graded: graded.length,
    scoreMean:
      graded.length && graded.every((r) => typeof r.score?.total === 'number')
        ? graded.reduce((s, r) => s + r.score!.total!, 0) / graded.length
        : null,
    correctRate: rate(rows, (r) => r.score!.correct === 2),
    citationRate: rate(citations, (r) => r.score!.citations === 2),
    refusalRate:
      none.length && none.every((r) => r.score && typeof r.score.refused === 'boolean')
        ? none.filter((r) => r.score!.refused && r.score!.honesty === 2).length / none.length
        : null,
    answerMsMean: timed.length ? timed.reduce((s, r) => s + r.answerMs!, 0) / timed.length : null,
    usage: {
      reported: reported.length,
      missing: rows.length - reported.length,
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      cachedInputTokens: sum('cachedInputTokens'),
      reasoningTokens: sum('reasoningTokens'),
      inputTokensMean: reported.length ? sum('inputTokens') / reported.length : null,
      outputTokensMean: reported.length ? sum('outputTokens') / reported.length : null
    }
  }
}
export function summarizeAnswerModels(rows: AnswerEvaluationRow[]) {
  const models = [...new Set(rows.map((r) => r.modelKey))],
    subtypes = [...new Set(rows.map((r) => r.subtype))]
  const byModel = Object.fromEntries(models.map((model) => [model, metrics(rows.filter((r) => r.modelKey === model))]))
  const bySubtype = Object.fromEntries(
    subtypes.map((type) => [
      type,
      Object.fromEntries(models.map((model) => [model, metrics(rows.filter((r) => r.modelKey === model && r.subtype === type))]))
    ])
  )
  const gapsOver10pp: { subtype: string; metric: string; a: number; b: number; gap: number }[] = []
  if (models.length === 2)
    for (const subtype of subtypes)
      for (const metric of ['correctRate', 'citationRate', 'refusalRate'] as const) {
        const a = bySubtype[subtype][models[0]][metric],
          b = bySubtype[subtype][models[1]][metric]
        if (a !== null && b !== null && Math.round(Math.abs(a - b) * 1_000_000) > 100000)
          gapsOver10pp.push({ subtype, metric, a, b, gap: Math.abs(a - b) })
      }
  return { modelOrder: models, byModel, bySubtype, gapsOver10pp }
}
