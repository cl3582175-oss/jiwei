import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve, relative, isAbsolute } from 'node:path'
import { launchRagApp } from './fixtures/ragApp'
import { percentile, scoreQuestion, summarize, type RagQuestion, type ScoredQuestion } from './fixtures/ragMetrics'

// 素材、金标、回答和结果都由环境变量指向仓库外；同一脚本可复制到 origin/main 跑基线。
test.skip(!process.env.JIWEI_RAG_EVAL, '设置 JIWEI_RAG_EVAL 与 JIWEI_RAG_CORPUS 运行真实语料评测')
test.describe.configure({ mode: 'serial' })

interface ManifestItem {
  id: string
  path: string
  needsOcr?: boolean
  needsAsr?: boolean
  /** 大扫描书 / 人物照片只测试不可检索状态，不自动识别。 */
  recognize?: boolean
}
interface PersonalNote {
  title: string
  learnedAt: string
  rows: { cue: string; body: string }[]
}
interface Personal {
  notes: PersonalNote[]
  annotations?: { title: string; quote: string; body: string }[]
  inbox: { text: string }[]
  transcripts: { title: string; text: string }[]
  mistakes?: { title: string; question: string; cause: string }[]
  unavailable?: Record<string, unknown[]>
}

let app: ElectronApplication
let page: Page
let directory: string
const evalDir = process.env.JIWEI_RAG_EVAL ? resolve(process.env.JIWEI_RAG_EVAL) : ''
const corpusDir = process.env.JIWEI_RAG_CORPUS ? resolve(process.env.JIWEI_RAG_CORPUS) : ''
const ocr = process.env.JIWEI_OCR === '1'
const asr = process.env.JIWEI_ASR === '1'
const seedOnly = process.env.JIWEI_RAG_SEED_ONLY === '1'
const reuse = process.env.JIWEI_RAG_REUSE_LIBRARY === '1'
const load = <T>(name: string): T => JSON.parse(readFileSync(join(evalDir, name), 'utf8')) as T
const paragraph = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })

function outsideRepo(path: string): void {
  const rel = relative(resolve('.'), path)
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('真实评测素材与结果必须保存在仓库外')
}

test.beforeAll(async () => {
  if (!corpusDir) throw new Error('缺少 JIWEI_RAG_CORPUS')
  outsideRepo(evalDir)
  outsideRepo(corpusDir)
  // 名字避开全局 cleanTemp 的 jiwei-* 清理规则，保留相同临时库供回答层评测。
  directory = process.env.JIWEI_RAG_USER_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'rag-v0145-eval-'))
  if (!resolve(directory).startsWith(resolve(tmpdir()) + '/')) throw new Error('评测只能使用临时 user-data-dir')
  mkdirSync(directory, { recursive: true })
  app = await launchRagApp(directory)
  page = await app.firstWindow()
  await page.waitForSelector('nav')
})
test.afterAll(async () => {
  await app?.close()
})

test('scenario retrieval baseline with separately requested 8 and 30 hits', async () => {
  test.setTimeout(3_600_000)
  const manifestFile = load<ManifestItem[] | { files: ManifestItem[] }>('manifest.json')
  const manifest = Array.isArray(manifestFile) ? manifestFile : manifestFile.files
  const personal = load<Personal>('personal.json')
  const questions = seedOnly ? [] : load<RagQuestion[]>('questions.json')
  const importErrors: { id: string; error: string }[] = []
  const ocrErrors: { id: string; failed: number }[] = []
  expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length)
  if (reuse) await page.evaluate(() => window.jiwei.embedding.installLocal())
  if (reuse && ocr && process.env.JIWEI_RAG_RETRY_OCR === '1') {
    // 修复后只重试隔离库里的失败页；保存原失败结果，不重写素材或全库基线。
    for (const source of await page.evaluate(() => window.jiwei.sources.list({}))) {
      const before = await page.evaluate((id) => window.jiwei.recognition.source(id), source.id)
      if (!before.failed) continue
      await page.evaluate((id) => window.jiwei.recognition.start(id), source.id)
      await expect
        .poll(
          async () => {
            const r = await page.evaluate((id) => window.jiwei.recognition.source(id), source.id)
            return !r.running && r.done + r.failed === r.total
          },
          { timeout: 1_800_000, intervals: [2000] }
        )
        .toBe(true)
    }
  }
  if (!reuse) {
    await page.evaluate(async () => {
      const s = await window.jiwei.settings.get()
      // 禁止真实云端模型；扫描古籍和人物图片不自动识别。
      await window.jiwei.settings.set({
        ai: {
          ...s.ai,
          embedding: { ...s.ai.embedding, mode: 'local' },
          recognition: { ...s.ai.recognition, auto: false, figures: false, mode: 'local', providerId: null, model: null }
        }
      })
    })
    await page.evaluate(() => window.jiwei.embedding.installLocal())
    if (ocr) await page.evaluate(() => window.jiwei.recognition.install())
    if (asr) await page.evaluate(() => window.jiwei.asr.install())
    for (const item of manifest) {
      if (item.needsAsr && !asr) continue
      const path = resolve(corpusDir, item.path)
      const rel = relative(corpusDir, path)
      if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('manifest 路径超出素材根目录')
      const result = await page.evaluate(async (p) => {
        try {
          return { ...(await window.jiwei.sources.importPaths([p])), failure: null }
        } catch (e) {
          return { imported: [], duplicates: 0, failure: String(e) }
        }
      }, path)
      if (result.failure) importErrors.push({ id: item.id, error: result.failure })
      for (const source of result.imported) {
        if (item.needsAsr && asr) await page.evaluate((id) => window.jiwei.asr.transcribe(id), source.id)
        // 分流登记完成之后再排 OCR；不能因立即检查零页而误判为已完成。
        await expect
          .poll(
            async () => {
              const jobs = await page.evaluate(() => window.jiwei.jobs.list())
              return !jobs.some((j) => j.key?.endsWith(source.id) && ['queued', 'running'].includes(j.status))
            },
            { timeout: 600_000, intervals: [1000] }
          )
          .toBe(true)
        if (ocr && item.recognize === true) {
          await page.evaluate((id) => window.jiwei.recognition.start(id), source.id)
          await expect
            .poll(
              async () => {
                const r = await page.evaluate((id) => window.jiwei.recognition.source(id), source.id)
                return !r.running && r.done + r.failed === r.total
              },
              { timeout: 1_800_000, intervals: [2000] }
            )
            .toBe(true)
          const recognition = await page.evaluate((id) => window.jiwei.recognition.source(id), source.id)
          if (recognition.failed) ocrErrors.push({ id: item.id, failed: recognition.failed })
        }
      }
    }
    for (const transcript of personal.transcripts) {
      const path = join(directory, `${basename(transcript.title).replace(/[\\/]/g, '-')}.txt`)
      writeFileSync(path, transcript.text)
      const r = await page.evaluate((p) => window.jiwei.sources.importPaths([p]), path)
      expect(r.imported.length + r.duplicates).toBeGreaterThan(0)
    }
    for (const note of personal.notes) {
      await page.keyboard.press('ControlOrMeta+n')
      await page.getByPlaceholder('笔记标题').fill(note.title)
      await page.keyboard.press('Enter')
      await page.keyboard.type(' ')
      await expect
        .poll(() => page.evaluate((t) => window.jiwei.notes.list({ search: t }).then((a) => a.length), note.title))
        .toBeGreaterThan(0)
      const id = await page.evaluate(
        (t) => window.jiwei.notes.list({ search: t }).then((a) => a.find((n) => n.title === t)!.id),
        note.title
      )
      const ops = note.rows.map((r) => ({
        op: 'insert_row' as const,
        afterRowId: null,
        cue: [paragraph(r.cue)],
        body: [paragraph(r.body)]
      }))
      await page.evaluate(
        async ({ id, note, ops }) => {
          await window.jiwei.notes.update(id, { learnedAt: Date.parse(note.learnedAt) })
          await window.jiwei.proposals.create({ noteId: id, title: '评测语料', ops })
        },
        { id, note, ops }
      )
      await page.getByRole('button', { name: '全部接受' }).click()
      await expect(page.getByRole('button', { name: '全部接受' })).toHaveCount(0)
      await expect
        .poll(() => page.evaluate((id) => window.jiwei.notes.blocks(id).then((a) => a.length), id))
        .toBeGreaterThanOrEqual(note.rows.length)
    }
    for (const item of personal.inbox)
      await page.evaluate((text) => window.jiwei.inbox.create({ kind: 'text', text, origin: {} }), item.text)
    // 手动错题可以保存，尚未纳入统一检索；不要通过伪装成笔记提升基线。
    for (const mistake of personal.mistakes ?? [])
      await page.evaluate(async (m) => {
        const r = await window.jiwei.mistakes.create({ text: m.question, localOnly: true, sourceRef: m.title, sourceKind: 'manual' })
        if (r.items[0]) await window.jiwei.mistakes.update(r.items[0].id, { causeReason: m.cause })
      }, mistake)
    await expect
      .poll(
        async () => {
          const status = await page.evaluate(() => window.jiwei.embedding.status())
          const jobs = await page.evaluate(() => window.jiwei.jobs.list())
          return status.state === 'ready' && status.indexed === status.total && !jobs.some((j) => ['queued', 'running'].includes(j.status))
        },
        { timeout: 600_000, intervals: [2000] }
      )
      .toBe(true)
    const notes = await page.evaluate(() => window.jiwei.notes.list({ limit: 1000 }))
    for (const a of personal.annotations ?? []) {
      const note = notes.find((n) => n.title === a.title)
      if (!note) throw new Error('合成批注的笔记不存在')
      await page.evaluate(
        async ({ id, a }) => {
          const b = (await window.jiwei.notes.blocks(id)).find((b) => b.text.includes(a.quote))
          if (!b) throw new Error('合成批注的原文不存在')
          await window.jiwei.annotations.create({
            targetType: 'note',
            targetId: id,
            selector: { ownerId: b.id, quote: a.quote },
            motivation: 'commenting',
            body: a.body
          })
        },
        { id: note.id, a }
      )
    }
  }
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
  // 汇总所有已导入资料，包含重开后复用的资料；失败页保留，最终断言仍要求失败为零。
  if (ocr) {
    for (const s of sources) {
      const r = await page.evaluate((id) => window.jiwei.recognition.source(id), s.id)
      if (r.failed && !ocrErrors.some((e) => e.id === s.id)) ocrErrors.push({ id: s.id, failed: r.failed })
    }
  }
  const corpusStats = await Promise.all(
    sources.map(async (s) => {
      const segs = await page.evaluate((id) => window.jiwei.segments.list(id), s.id)
      const status = await page.evaluate((id) => window.jiwei.sources.indexStatus(id), s.id)
      return {
        sourceId: s.id,
        title: s.title,
        extension: extname(s.originalName ?? s.title),
        status,
        lengths: segs.map((a) => a.text.length)
      }
    })
  )
  const rows: ScoredQuestion[] = []
  for (const q of questions) {
    if ((q.needsOcr && !ocr) || (q.needsAsr && !asr)) continue
    const scopeSources = q.scope?.length ? sources.filter((s) => q.scope!.some((t) => s.title.includes(t))).map((s) => s.id) : []
    const scopeNotes = q.scope?.length ? notes.filter((n) => q.scope!.some((t) => n.title.includes(t))).map((n) => n.id) : []
    const scope = q.scope?.length ? { type: 'items' as const, sources: scopeSources, notes: scopeNotes } : { type: 'all' as const }
    // P4 之后才启用应用暴露的组合函数；基线严格使用原追问。
    const query =
      process.env.JIWEI_RAG_QUERY_FOR === '1'
        ? await page.evaluate(
            async ({ text, prev }) => {
              const knowledge = window.jiwei.knowledge as typeof window.jiwei.knowledge & {
                queryFor(text: string, prev: string | null): Promise<string>
              }
              return knowledge.queryFor(text, prev)
            },
            { text: q.q, prev: q.prev ?? null }
          )
        : q.q
    const t8 = performance.now()
    const hits8 = await page.evaluate(({ query, scope }) => window.jiwei.knowledge.search(query, scope, 8), { query, scope })
    const ms8 = performance.now() - t8
    const t30 = performance.now()
    const hits30 = await page.evaluate(({ query, scope }) => window.jiwei.knowledge.search(query, scope, 30), { query, scope })
    rows.push(scoreQuestion(q, hits8, hits30, { ms8, ms30: performance.now() - t30, scopeIds: [...scopeSources, ...scopeNotes] }))
  }
  const lengths = corpusStats.flatMap((s) => s.lengths)
  const report = {
    stage: process.env.JIWEI_RAG_STAGE ?? 'baseline',
    date: new Date().toISOString(),
    ocr,
    asr,
    userData: directory,
    seedOnly,
    ocrErrors,
    importErrors: reuse ? [] : importErrors,
    unavailableTypes: Object.keys(personal.unavailable ?? {}),
    annotationCount: personal.annotations?.length ?? 0,
    corpus: {
      sources: sources.length,
      segments: lengths.length,
      p10: percentile(lengths, 0.1),
      p50: percentile(lengths, 0.5),
      p90: percentile(lengths, 0.9),
      below6: lengths.filter((n) => n < 6).length,
      below80: lengths.filter((n) => n < 80).length,
      emptyByExtension: Object.fromEntries(
        [...new Set(corpusStats.map((s) => s.extension))].map((ext) => [
          ext,
          corpusStats.filter((s) => s.extension === ext && !s.lengths.length).length
        ])
      ),
      sourceStats: corpusStats
    },
    ...summarize(rows)
  }
  const resultsDir = join(evalDir, 'results')
  mkdirSync(resultsDir, { recursive: true })
  const name = `${report.stage}-${ocr ? 'ocr' : 'no-ocr'}-${report.date.replace(/[:.]/g, '-')}.json`
  writeFileSync(join(resultsDir, name), JSON.stringify(report, null, 2))
  writeFileSync(join(evalDir, 'library.json'), JSON.stringify({ userData: directory, sources, notes, result: name }, null, 2))
  console.log(
    JSON.stringify({
      stage: report.stage,
      overall: report.overall,
      byScenario: report.byScenario,
      bySubtype: report.bySubtype,
      corpus: { sources: report.corpus.sources, segments: lengths.length, p50: report.corpus.p50 },
      importErrorCount: importErrors.length
    })
  )
  expect(ocrErrors, '原有 OCR 失败已完整写入结果；存在失败时基线不是通过状态').toHaveLength(0)
})
