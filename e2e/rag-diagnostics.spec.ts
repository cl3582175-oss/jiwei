import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { launchRagApp } from './fixtures/ragApp'
import { normalizeGold, scoreQuestion, type ScoredQuestion } from './fixtures/ragMetrics'

test.skip(process.env.JIWEI_RAG_DIAGNOSTICS !== '1', '仅诊断外部评测失败题，不改变正式检索指标')

test('diagnose missing evidence with the same query constrained to its gold parents', async () => {
  test.setTimeout(900_000)
  const directory = resolve(process.env.JIWEI_RAG_EVAL ?? '')
  const rel = relative(resolve('.'), directory)
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('诊断数据必须放在仓库外')
  const input = process.env.JIWEI_RAG_DIAG_RESULT
  if (!input) throw new Error('缺少原始评测结果')
  const original = JSON.parse(readFileSync(input, 'utf8')) as { rows: ScoredQuestion[] }
  const library = JSON.parse(readFileSync(join(directory, process.env.JIWEI_RAG_LIBRARY_FILE ?? 'library.json'), 'utf8')) as {
    userData: string
  }
  if (!resolve(library.userData).startsWith(resolve(tmpdir()) + '/')) throw new Error('只能使用隔离评测库')
  const app = await launchRagApp(library.userData)
  try {
    const page = await app.firstWindow()
    await page.waitForSelector('nav')
    await page.evaluate(() => window.jiwei.embedding.installLocal())
    await expect
      .poll(
        async () => {
          const s = await page.evaluate(() => window.jiwei.embedding.status())
          return s.state === 'ready' && s.indexed === s.total
        },
        { timeout: 600_000, intervals: [2000] }
      )
      .toBe(true)
    const sources = await page.evaluate(() => window.jiwei.sources.list({}))
    const notes = await page.evaluate(() => window.jiwei.notes.list({ limit: 1000 }))
    const sourceUnits = await Promise.all(
      sources.map(async (s) => ({
        ...s,
        units: await page.evaluate((id) => window.jiwei.segments.list(id), s.id)
      }))
    )
    const noteUnits = await Promise.all(
      notes.map(async (n) => ({
        ...n,
        units: await page.evaluate((id) => window.jiwei.notes.blocks(id), n.id)
      }))
    )
    const failures = original.rows.filter((q) => !q.expectNone && q.gold?.length && q.rank8 === null)
    const results: unknown[] = []
    const output = join(directory, 'results', `diagnostics-${Date.now()}.json`)
    for (const q of failures) {
      const titles = q.gold!.map((g) => normalizeGold(g.title))
      const matching = (s: { title: string }) => titles.some((t) => normalizeGold(s.title).includes(t))
      const targetSources = sourceUnits.filter(matching),
        targetNotes = noteUnits.filter(matching)
      const scope = { type: 'items' as const, sources: targetSources.map((s) => s.id), notes: targetNotes.map((n) => n.id) }
      const query = await page.evaluate(({ text, prev }) => window.jiwei.knowledge.queryFor(text, prev), {
        text: q.q,
        prev: q.prev ?? null
      })
      const hits8 = await page.evaluate(({ query, scope }) => window.jiwei.knowledge.search(query, scope, 8), { query, scope })
      const hits30 = await page.evaluate(({ query, scope }) => window.jiwei.knowledge.search(query, scope, 30), { query, scope })
      const forced = scoreQuestion(q, hits8, hits30, { ms8: 0, ms30: 0, scopeIds: [...scope.sources, ...scope.notes] })
      results.push({
        id: q.id,
        subtype: q.subtype,
        gated: q.gated,
        unavailable: q.unavailable,
        original: q,
        forced,
        sourceUnits: targetSources.map((s) => ({ id: s.id, title: s.title, units: s.units })),
        noteUnits: targetNotes.map((n) => ({ id: n.id, title: n.title, units: n.units }))
      })
      writeFileSync(output, JSON.stringify({ diagnosticOnly: true, originalResult: input, results }, null, 2))
    }
    expect(results).toHaveLength(failures.length)
    console.log(JSON.stringify({ diagnosed: results.length, output }))
  } finally {
    await app.close()
  }
})
