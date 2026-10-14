export function parseJudgement(
  text: string
): { correct: number; complete: number; citations: number; honesty: number; reason: string; total: number } | null {
  const begin = text.indexOf('{'),
    end = text.lastIndexOf('}')
  if (begin < 0 || end <= begin) return null
  try {
    const value = JSON.parse(text.slice(begin, end + 1)) as Record<string, unknown>
    const keys = ['correct', 'complete', 'citations', 'honesty'] as const
    if (keys.some((k) => typeof value[k] !== 'number' || !Number.isInteger(value[k]) || Number(value[k]) < 0 || Number(value[k]) > 2))
      return null
    const [correct, complete, citations, honesty] = keys.map((k) => Number(value[k]))
    return {
      correct,
      complete,
      citations,
      honesty,
      reason: typeof value.reason === 'string' ? value.reason : '',
      total: correct + complete + citations + honesty
    }
  } catch {
    return null
  }
}
