import { app } from 'electron'
import { isAbsolute, relative } from 'node:path'
import { openDatabase, closeDatabase, dataDir } from '../../src/main/db'
import { getSettings, setSettings } from '../../src/main/services/settings'
import { embed, installLocal, isReady, shutdown } from '../../src/main/services/ai/embedding'
import { coverage, scoreKb, scoreWeb, selectPassages, allocate, TUNING, type ScoredWeb } from '../../src/main/services/retrieval/scoring'
import type { ReadPage } from '../../src/main/services/retrieval/reader'
import type { SearchHit } from '../../src/shared/types'
import { WEB_EVAL, type WebEvalCase } from './webEval'

const REL_VALUES = [0.45, 0.5, 0.55, 0.6, 0.65]
const FLOOR_VALUES = [0.25, 0.3, 0.35, 0.4]
const DAY = 86_400_000

interface CaseScores {
  corpus: WebEvalCase
  kb: SearchHit[]
  web: ScoredWeb[]
}

function validVectors(vectors: number[][], count: number): void {
  if (
    vectors.length !== count ||
    vectors.some((v) => v.length !== 512 || v.some((x) => !Number.isFinite(x)) || Math.abs(v.reduce((n, x) => n + x * x, 0) - 1) > 0.001)
  )
    throw new Error('Calibration requires real normalized 512-dimensional vectors')
}

function goldHit(entry: ScoredWeb, sample: WebEvalCase): boolean {
  return sample.pages.some((page) => page.paragraphs.some((p) => p.gold && p.text === entry.hit.text))
}

function relevantHit(entry: ScoredWeb, sample: WebEvalCase): boolean {
  return sample.pages.some((page) => page.paragraphs.some((p) => p.relevant && p.text === entry.hit.text))
}

/** 独立Electron bundle复用生产评分；测试只做指标统计，不另写评分公式。 */
export async function runWebEval() {
  const started = performance.now()
  const original = { REL: TUNING.REL, FLOOR: TUNING.FLOOR }
  const at = Date.now()
  await openDatabase()
  try {
    const vault = relative(app.getPath('userData'), dataDir())
    if (!vault || vault.startsWith('..') || isAbsolute(vault)) throw new Error('Evaluation vault is not isolated')
    const settings = getSettings()
    setSettings({
      ai: { ...settings.ai, embedding: { mode: 'local', providerId: null, model: null } },
      retrieval: { trustedSites: [], lowTrustSites: [] }
    })
    if (!(await isReady())) await installLocal()
    const embeddingStarted = performance.now()
    const queries = await embed(
      WEB_EVAL.map((sample) => sample.question),
      'query'
    )
    validVectors(queries, WEB_EVAL.length)
    const rows = WEB_EVAL.flatMap((sample) => sample.notes)
    const docs = await embed(
      rows.map((row) => row.text),
      'doc',
      rows.map((row) => row.title)
    )
    validVectors(docs, rows.length)
    let index = 0
    const cases: CaseScores[] = []
    for (const [caseIndex, corpus] of WEB_EVAL.entries()) {
      const kb: SearchHit[] = corpus.notes.map((row, rowIndex) => {
        // 与retrieve返回的sim口径一致：真实query/doc向量点积夹到[0,1]。
        const sim = Math.max(
          0,
          Math.min(
            1,
            docs[index++].reduce((sum, x, dimension) => sum + x * queries[caseIndex][dimension], 0)
          )
        )
        return {
          parentType: 'note',
          parentId: `${corpus.id}-note-${rowIndex}`,
          ownerId: `${corpus.id}-row-${rowIndex}`,
          title: row.title,
          text: row.text,
          locator: null,
          score: sim,
          sim,
          learnedAt: null,
          updatedAt: at - 600 * DAY,
          status: 'active',
          origin: 'user',
          via: 'semantic'
        }
      })
      const web = await scoreWeb(
        corpus.pages.flatMap((page, pageIndex) =>
          page.paragraphs.map((paragraph) => ({
            pageId: `${corpus.id}-page-${pageIndex}`,
            url: `https://web-eval.example/${corpus.id}/${pageIndex}`,
            title: page.title,
            text: paragraph.text,
            publishedAt: corpus.kind === 'C' ? at - DAY : null,
            fetchedAt: at
          }))
        ),
        corpus.question,
        { timeSensitive: corpus.kind === 'C' }
      )
      if (web.some((hit) => hit.fallback || !Number.isFinite(hit.score)))
        throw new Error('Lexical fallback cannot calibrate semantic thresholds')
      cases.push({ corpus, kb, web })
    }
    const embeddingMs = Math.round(performance.now() - embeddingStarted)
    const coverageTable = REL_VALUES.map((rel) => {
      Object.assign(TUNING, { REL: rel })
      const perCase = cases.map(({ corpus, kb }) => {
        // C的旧内容仍可能语义充足；覆盖不判断新旧事实的正确性。
        const expected = corpus.kind === 'B' ? 'none' : 'enough'
        const actual = coverage(kb)
        return {
          id: corpus.id,
          kind: corpus.kind,
          lang: corpus.lang,
          expected,
          actual,
          correct: expected === actual,
          sims: kb.map((h) => h.sim)
        }
      })
      const correct = perCase.filter((entry) => entry.correct).length
      return {
        rel,
        correct,
        total: perCase.length,
        accuracy: correct / perCase.length,
        byKind: Object.fromEntries(
          ['A', 'B', 'C'].map((kind) => [kind, perCase.filter((entry) => entry.kind === kind && entry.correct).length])
        ),
        perCase
      }
    })
    const floorTable = FLOOR_VALUES.map((floor) => {
      Object.assign(TUNING, { FLOOR: floor })
      const perCase = cases.map(({ corpus, kb, web }) => {
        // 跨网页候选池的前6段指标；先按真实生产分数排序，再应用候选阈值。
        const ranked = [...web].sort((a, b) => b.score - a.score)
        const selected = ranked.filter((entry) => entry.score >= floor).slice(0, 6)
        const irrelevant = web.filter((entry) => !relevantHit(entry, corpus))
        const gold = ranked.find((entry) => goldHit(entry, corpus))!
        const merged = allocate(scoreKb(kb), web)
        return {
          id: corpus.id,
          kind: corpus.kind,
          lang: corpus.lang,
          goldScore: gold.score,
          goldRank: ranked.indexOf(gold) + 1,
          goldSelected: selected.includes(gold),
          selected: selected.map((entry) => ({
            pageId: entry.hit.pageId,
            score: entry.score,
            gold: goldHit(entry, corpus),
            relevant: relevantHit(entry, corpus)
          })),
          irrelevant: irrelevant.length,
          thresholdDiscarded: irrelevant.filter((entry) => entry.score < floor).length,
          discarded: irrelevant.filter((entry) => !selected.includes(entry)).length,
          allocation: { kb: merged.kb.length, web: merged.web.length, both: merged.kb.length > 0 && merged.web.length > 0 }
        }
      })
      const goldCount = perCase.filter((entry) => entry.goldSelected).length
      const irrelevant = perCase.reduce((sum, entry) => sum + entry.irrelevant, 0)
      const discarded = perCase.reduce((sum, entry) => sum + entry.discarded, 0)
      const thresholdDiscarded = perCase.reduce((sum, entry) => sum + entry.thresholdDiscarded, 0)
      const conflicts = perCase.filter((entry) => entry.kind === 'C')
      return {
        floor,
        goldCount,
        total: perCase.length,
        goldRecallAt6: goldCount / perCase.length,
        irrelevant,
        discarded,
        discardRate: discarded / irrelevant,
        thresholdDiscarded,
        thresholdDiscardRate: thresholdDiscarded / irrelevant,
        conflictsBoth: conflicts.filter((entry) => entry.allocation.both).length,
        conflictsTotal: conflicts.length,
        perCase
      }
    })
    const chosenRel = [...coverageTable].sort((a, b) => b.accuracy - a.accuracy || b.rel - a.rel)[0].rel
    const chosenFloor = [...floorTable].filter((row) => row.goldRecallAt6 >= 0.9).sort((a, b) => b.floor - a.floor)[0]?.floor ?? null
    Object.assign(TUNING, { REL: chosenRel, FLOOR: chosenFloor ?? original.FLOOR })
    const readerDiagnostics = []
    for (const { corpus } of cases) {
      const pageIndex = corpus.pages.findIndex((page) => page.paragraphs.some((paragraph) => paragraph.gold))
      const page = corpus.pages[pageIndex]
      const text = page.paragraphs.map((paragraph) => paragraph.text).join('\n\n')
      let offset = 0
      const read: ReadPage = {
        page: {
          id: `${corpus.id}-page-${pageIndex}`,
          url: `https://web-eval.example/${corpus.id}/${pageIndex}`,
          title: page.title,
          siteName: 'web-eval.example',
          publishedAt: corpus.kind === 'C' ? at - DAY : null,
          fetchedAt: at,
          method: 'fetch',
          text
        },
        passages: page.paragraphs.map((paragraph, index) => {
          const start = offset
          offset += paragraph.text.length + 2
          return { index, start, end: start + paragraph.text.length, text: paragraph.text, suspicious: false }
        })
      }
      const selected = await selectPassages(read, corpus.question, { timeSensitive: corpus.kind === 'C', k: 6 })
      readerDiagnostics.push({
        id: corpus.id,
        goldSelected: selected.some((entry) => page.paragraphs.some((p) => p.gold && p.text === entry.text)),
        selected: selected.map((entry) => ({ index: entry.index, score: entry.score, fallback: entry.fallback }))
      })
    }
    return {
      model: 'embeddinggemma-2-Q8_0',
      dimensions: 512,
      at,
      cases: WEB_EVAL.length,
      languages: {
        zh: WEB_EVAL.filter((sample) => sample.lang === 'zh').length,
        en: WEB_EVAL.filter((sample) => sample.lang === 'en').length
      },
      kinds: Object.fromEntries(['A', 'B', 'C'].map((kind) => [kind, WEB_EVAL.filter((sample) => sample.kind === kind).length])),
      notes: rows.length,
      passages: cases.reduce((sum, item) => sum + item.web.length, 0),
      coverageTable,
      floorTable,
      selected: { REL: chosenRel, FLOOR: chosenFloor },
      readerDiagnostics,
      scores: cases.map(({ corpus, kb, web }) => ({
        id: corpus.id,
        kb: kb.map((h) => ({ title: h.title, sim: h.sim })),
        web: web.map((h) => ({ pageId: h.hit.pageId, score: h.score, gold: goldHit(h, corpus), relevant: relevantHit(h, corpus) }))
      })),
      embeddingMs,
      totalMs: Math.round(performance.now() - started)
    }
  } finally {
    Object.assign(TUNING, original)
    shutdown()
    closeDatabase()
  }
}

export type WebEvalReport = Awaited<ReturnType<typeof runWebEval>>
