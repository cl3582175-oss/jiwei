import { test, expect } from '@playwright/test'
import { makeMistakeImages } from './fixtures/mistakes-images'
import { addImage, mistakeShot, mistakeJobEvidence, openMistakes, semanticEvidence, startMistakesApp, type MistakesApp } from './fixtures/mistakes-app'

test.describe('真实服务商错题语义验收', () => {
  test.skip(!process.env.JIWEI_IMPORT_PROVIDERS_FROM, '由既有授权loader提供配置；不读取或输出凭证')
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(600000)
  let env: MistakesApp, files: ReturnType<typeof makeMistakeImages>
  test.beforeAll(async () => { files = makeMistakeImages(); env = await startMistakesApp({ provider: false, importProviders: process.env.JIWEI_IMPORT_PROVIDERS_FROM }); expect((await env.page.evaluate(() => window.jiwei.settings.get())).ai.chat.model).toBeTruthy() })
  test.afterEach(async () => {
    if (!env) return
    const items = await env.page.evaluate(() => window.jiwei.mistakes.list())
    const variants = await env.page.evaluate(async () => {
      const mistakes = await window.jiwei.mistakes.list()
      return Promise.all(mistakes.map(async (m) => ({ mistakeId: m.id, variants: await window.jiwei.mistakes.variants(m.id) })))
    })
    semanticEvidence('mistakes-provider-observation.json', { evidenceType: 'real-provider-content-for-human-review', observedAt: new Date().toISOString(), statsScope: 'done-jobs-only', userData: env.userData, items, variants, stats: await env.page.evaluate(() => window.jiwei.mistakes.variantStats()), jobs: await mistakeJobEvidence(env) })
  })
  test.afterAll(async () => env?.close())
  test('三张canvas原件忠实拆分，数学错误引用具体步骤，AI求解待核对，变式经独立求解', async () => {
    const math = await addImage(env, 'math', files)
    semanticEvidence('mistakes-provider-math.json', { evidenceType: 'real-provider-content-for-human-review', model: (await env.page.evaluate(() => window.jiwei.settings.get())).ai.chat.model, math, jobs: await mistakeJobEvidence(env) })
    expect(math).toHaveLength(1)
    expect(math[0].question).toMatch(/(?:5x|5\s*x|5\\,?x)/)
    expect(math[0].question).toContain('6')
    expect(math[0].myAnswer).toContain('9')
    expect(['calculation', 'method']).toContain(math[0].cause)
    expect(math[0].causeReason).toMatch(/25|24|9/)
    expect(math[0].correctAnswer).toMatch(/2/); expect(math[0].correctAnswer).toMatch(/3/)
    expect(math[0].answerOrigin).toBe('ai'); expect(math[0].verified).toBe(false)
    const physics = await addImage(env, 'physics', files)
    semanticEvidence('mistakes-provider-physics.json', { evidenceType: 'real-provider-content-for-human-review', physics })
    expect(physics).toHaveLength(1); expect(physics[0].subject).toBe('physics'); expect(physics[0].correctAnswer).toMatch(/6\s*(?:N|牛顿)/)
    const multi = await addImage(env, 'multi', files)
    semanticEvidence('mistakes-provider-multi.json', { evidenceType: 'real-provider-content-for-human-review', multi })
    expect(multi).toHaveLength(2); expect(multi.map((m) => m.subject).sort()).toEqual(['math', 'physics'])
    const variantJobId = await env.page.evaluate(async (id) => { await window.jiwei.mistakes.update(id, { verified: true }); return window.jiwei.mistakes.replenish(id, true) }, math[0].id)
    await expect.poll(() => env.page.evaluate(async ({ id, jobId }) => {
      if ((await window.jiwei.mistakes.variants(id)).some((v) => !v.flagged)) return 'ready'
      const job = (await window.jiwei.jobs.list()).find((j) => j.id === jobId)
      return job?.status === 'done' || job?.status === 'failed' || job?.status === 'canceled' ? 'empty-terminal-pool' : 'pending'
    }, { id: math[0].id, jobId: variantJobId }), { timeout: 300000, intervals: [1000, 2000, 5000] }).not.toBe('pending')
    expect((await env.page.evaluate((id) => window.jiwei.mistakes.variants(id), math[0].id)).filter((v) => !v.flagged).length).toBeGreaterThanOrEqual(1)
    const variants = await env.page.evaluate((id) => window.jiwei.mistakes.variants(id), math[0].id)
    expect(variants.every((v) => v.answer.trim() && v.solution.trim() && v.question !== math[0].question)).toBe(true)
    const ready = variants.find((v) => !v.flagged && v.usedAt === null)!
    const answerCheck = await env.page.evaluate(({ id, variantId, answer }) => window.jiwei.mistakes.check(id, variantId, answer), { id: math[0].id, variantId: ready.id, answer: ready.answer })
    expect(answerCheck.suggested).toBeGreaterThanOrEqual(3); expect(answerCheck.wrong).toHaveLength(0)
    await expect.poll(() => env.page.evaluate(() => window.jiwei.jobs.list().then((jobs) => jobs.filter((j) => j.kind === 'mistake-variants').every((j) => j.status !== 'running' && j.status !== 'queued'))), { timeout: 300000, intervals: [1000, 2000, 5000] }).toBe(true)
    await openMistakes(env)
    await env.page.locator(`[data-mistake-id="${math[0].id}"]`).click()
    await mistakeShot(env, 'mistakes-provider-math-details.png')
    const terminalVariants = await env.page.evaluate((id) => window.jiwei.mistakes.variants(id), math[0].id)
    const allVariants = await env.page.evaluate(async () => Promise.all((await window.jiwei.mistakes.list()).map(async (m) => ({ mistakeId: m.id, variants: await window.jiwei.mistakes.variants(m.id) }))))
    const evidence = { evidenceType: 'real-provider-content-for-human-review', observedAt: new Date().toISOString(), statsScope: 'done-jobs-only', model: (await env.page.evaluate(() => window.jiwei.settings.get())).ai.chat.model, math, physics, multi, variants: terminalVariants, allVariants, answerCheck, stats: await env.page.evaluate(() => window.jiwei.mistakes.variantStats()), jobs: await mistakeJobEvidence(env) }
    semanticEvidence('mistakes-provider-semantic.json', evidence)
    console.log(JSON.stringify({ model: evidence.model, mathCause: math[0].cause, mathReason: math[0].causeReason, split: [math.length, physics.length, multi.length], variants: evidence.variants.length, stats: evidence.stats }))
  })
})
