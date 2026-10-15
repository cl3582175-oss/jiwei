/** 与应用版本解耦的评测判定；只读取外部金标，绝不内置真实素材。 */
export interface RagQuestion {
  id: string
  scenario: string
  subtype: string
  q: string
  prev?: string
  scope?: string[]
  gold?: { title: string; quote: string }[]
  goldAll?: { title: string }[]
  expectNone?: boolean
  needsOcr?: boolean
  needsAsr?: boolean
  gated: string
  /** 现有接口不能检索的数据仍参与计分；不能静默剔除。 */
  unavailable?: string
}

export interface EvalHit {
  text: string
  title: string
  heading?: string
  locator?: string | null
  parentType: string
  parentId: string
  ownerId: string
  score: number
  sim?: number
}

export function normalizeGold(text: string): string {
  return [...text]
    .map((ch) => {
      const n = ch.codePointAt(0)!
      if (ch === '⻛') return '风'
      if ((n >= 0x2e80 && n <= 0x2eff) || (n >= 0x2f00 && n <= 0x2fdf) || (n >= 0xf900 && n <= 0xfaff) || (n >= 0x2f800 && n <= 0x2fa1f)) {
        const normalized = ch.normalize('NFKC')
        if (/^\p{Script=Han}$/u.test(normalized)) return normalized
      }
      if ((n >= 0xff10 && n <= 0xff19) || (n >= 0xff21 && n <= 0xff3a) || (n >= 0xff41 && n <= 0xff5a))
        return String.fromCodePoint(n - 0xfee0)
      if ((n >= 0x200b && n <= 0x200d) || n === 0xfeff) return ''
      return n === 0xa0 ? ' ' : ch
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}

export function scoreQuestion(
  q: RagQuestion,
  hits8: EvalHit[],
  hits30: EvalHit[],
  timing: { ms8: number; ms30: number; scopeIds: string[] }
) {
  const matches = (h: EvalHit): boolean =>
    (q.gold ?? []).some(
      (g) =>
        normalizeGold(h.title).includes(normalizeGold(g.title)) &&
        normalizeGold(`${h.heading ?? ''}\n${h.text}`).includes(normalizeGold(g.quote))
    )
  const rank = (hits: EvalHit[]): number | null => {
    const i = hits.findIndex(matches)
    return i === -1 ? null : i + 1
  }
  const outside = (hits: EvalHit[]): number => (q.scope?.length ? hits.filter((h) => !timing.scopeIds.includes(h.parentId)).length : 0)
  return {
    ...q,
    rank8: rank(hits8.slice(0, 8)),
    rank30: rank(hits30.slice(0, 30)),
    firstSourceCorrect:
      q.subtype === 'disambig'
        ? !!hits8[0] && (q.gold ?? []).some((g) => normalizeGold(hits8[0].title).includes(normalizeGold(g.title)))
        : null,
    coverage30: q.goldAll?.length
      ? q.goldAll.filter((g) => hits30.some((h) => normalizeGold(h.title).includes(normalizeGold(g.title)))).length / q.goldAll.length
      : null,
    outOfScope8: outside(hits8),
    outOfScope30: outside(hits30),
    highestRetrievalScore: q.expectNone ? Math.max(0, ...hits8.map((h) => h.score)) : null,
    highestSimilarity:
      q.expectNone && hits8.some((h) => h.sim !== undefined)
        ? Math.max(...hits8.flatMap((h) => (h.sim === undefined ? [] : [h.sim])))
        : null,
    ms8: timing.ms8,
    ms30: timing.ms30,
    // 审查者需要真实前 8 / 30 条；失败摘要只显示前三条的前 40 字。
    hits8,
    hits30,
    actualTop3: hits8.slice(0, 3).map((h) => ({ title: h.title, text: h.text.slice(0, 40) }))
  }
}

export type ScoredQuestion = ReturnType<typeof scoreQuestion>

function groupMetrics(rows: ScoredQuestion[]) {
  const answerable = rows.filter((r) => !r.expectNone && !!r.gold?.length)
  const at = (k: number, field: 'rank8' | 'rank30'): number | null =>
    answerable.length ? answerable.filter((r) => r[field] !== null && r[field]! <= k).length / answerable.length : null
  const mrr = (field: 'rank8' | 'rank30'): number | null =>
    answerable.length ? answerable.reduce((s, r) => s + (r[field] ? 1 / r[field]! : 0), 0) / answerable.length : null
  const disambig = rows.filter((r) => r.firstSourceCorrect !== null)
  const coverage = rows.filter((r) => r.coverage30 !== null)
  return {
    count: rows.length,
    answerable: answerable.length,
    recall1: at(1, 'rank8'),
    recall3: at(3, 'rank8'),
    recall8: at(8, 'rank8'),
    recall30: at(30, 'rank30'),
    mrr8: mrr('rank8'),
    mrr30: mrr('rank30'),
    firstSourceAccuracy: disambig.length ? disambig.filter((r) => r.firstSourceCorrect).length / disambig.length : null,
    coverage30: coverage.length ? coverage.reduce((s, r) => s + r.coverage30!, 0) / coverage.length : null,
    outOfScope8: rows.reduce((s, r) => s + r.outOfScope8, 0),
    outOfScope30: rows.reduce((s, r) => s + r.outOfScope30, 0),
    noAnswerScores: rows.filter((r) => r.expectNone).map((r) => ({ id: r.id, score: r.highestRetrievalScore })),
    noAnswerSimilarities: rows.filter((r) => r.expectNone).map((r) => ({ id: r.id, similarity: r.highestSimilarity })),
    latency8: {
      p50: percentile(
        rows.map((r) => r.ms8),
        0.5
      ),
      p95: percentile(
        rows.map((r) => r.ms8),
        0.95
      )
    },
    latency30: {
      p50: percentile(
        rows.map((r) => r.ms30),
        0.5
      ),
      p95: percentile(
        rows.map((r) => r.ms30),
        0.95
      )
    }
  }
}

export function summarize(rows: ScoredQuestion[]) {
  const groups = (field: 'scenario' | 'subtype' | 'gated') =>
    Object.fromEntries([...new Set(rows.map((r) => r[field]))].map((v) => [v, groupMetrics(rows.filter((r) => r[field] === v))]))
  return {
    overall: groupMetrics(rows),
    byScenario: groups('scenario'),
    bySubtype: groups('subtype'),
    byVersion: groups('gated'),
    scoreKind: 'Application RRF ranking score; not cosine similarity',
    failures: rows.filter((r) => !r.expectNone && !!r.gold?.length && r.rank8 === null),
    rows
  }
}
