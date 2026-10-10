import { test, expect } from '@playwright/test'
import { startLensApp, seedTranscript, runLens, type LensApp } from './fixtures/lensApp'
import { nearVerbatim } from '../src/main/lib/lensEvidence'

test.describe('真实服务商视角语义条件验收', () => {
  test.skip(!process.env.JIWEI_IMPORT_PROVIDERS_FROM, '由审查者通过既有 loader 提供服务商配置；不读取或输出凭证')
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240000)
  let env: LensApp
  test.beforeAll(async () => {
    env = await startLensApp({ provider: false, importProviders: process.env.JIWEI_IMPORT_PROVIDERS_FROM })
    expect((await env.page.evaluate(() => window.jiwei.settings.get())).ai.chat.model).toBeTruthy()
  })
  test.afterAll(async () => env?.close())
  test('会议：决策、可解析负责人、至少八成条目有有效证据', async () => {
    const { sourceId } = await seedTranscript(env, 'meeting'),
      d = await runLens(env, sourceId, 'lens-meeting', 210000)
    expect(
      d.result?.items
        .filter((i) => i.category === 'decision')
        .map((i) => i.body)
        .join('')
    ).toContain('下周试用')
    expect(d.result?.items.some((i) => i.category === 'action' && i.ownerPersonId)).toBe(true)
    const lost = d.stats?.dropped.filter((d) => !d.field && ['missing_reference', 'irrelevant', 'limit'].includes(d.reason)).length ?? 0,
      kept = d.result?.items.length ?? 0
    expect(kept / (kept + lost || 1)).toBeGreaterThanOrEqual(0.8)
    console.log(JSON.stringify({ lens: 'meeting', model: d.model, accepted: kept, dropped: lost, ratio: kept / (kept + lost || 1) }))
  })
  test('课堂：至少四行康奈尔行，线索都是问句', async () => {
    const { sourceId } = await seedTranscript(env, 'lecture'),
      d = await runLens(env, sourceId, 'lens-lecture', 210000),
      rows = d.result?.items.filter((i) => i.category === 'row') ?? []
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rows.every((i) => /[?？]/.test(i.cue ?? ''))).toBe(true)
  })
  test('随想：整理稿引语逐字出现在引用转写稿中', async () => {
    const { sourceId } = await seedTranscript(env, 'thought'),
      d = await runLens(env, sourceId, 'lens-thought', 210000),
      quotes = d.result?.items.filter((i) => i.category === 'paragraph' && i.quote) ?? []
    expect(quotes.length).toBeGreaterThan(0)
    const normalizeQuote = (text: string): string => text.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '')
    for (const i of quotes) {
      const evidence = i.evidence.map((ref) => d.result!.sentences.find((s) => s.ref === ref)!.text).join('\n')
      expect(nearVerbatim(i.quote!, evidence)).toBe(true)
      expect(normalizeQuote(evidence)).toContain(normalizeQuote(i.quote!))
    }
  })
  test('场景判断：只记录三种场景和把握程度', async () => {
    for (const kind of ['meeting', 'lecture', 'thought'] as const) {
      const { sourceId } = await seedTranscript(env, kind, { scene: 'unspecified' })
      const guess = await env.page.evaluate((id) => window.jiwei.lenses.guess(id), sourceId)
      console.log(JSON.stringify({ fixture: kind, ...guess }))
    }
  })
})
