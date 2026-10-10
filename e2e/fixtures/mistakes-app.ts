import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { MATH_QUESTION, MATH_MY_ANSWER, PHYSICS_QUESTION, PHYSICS_MY_ANSWER } from './mistakes-images'
import type { Mistake } from '../../src/shared/mistakes'

export interface MistakesApp {
  app: ElectronApplication; page: Page; userData: string; provider: Server
  requests: { kind: string; prompt: string; data: Record<string, unknown>; images: number }[]
  state: { blocked: string | null; release: (() => void)[]; mismatch: number; counter: number; fail: boolean; failAfterIndependent: number | null }
  close(): Promise<void>
}
type OcrBlock = { index: number; text: string; box: number[] }
export async function startMistakesApp(options: { provider?: boolean; importProviders?: string; userData?: string } = {}): Promise<MistakesApp> {
  const requests: MistakesApp['requests'] = [], state: MistakesApp['state'] = { blocked: null, release: [], mismatch: 0, counter: 0, fail: false, failAfterIndependent: null }
  const answers = new Map<string, string>()
  const provider = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString() })
    request.on('end', () => { void (async () => {
      try {
        const input = JSON.parse(body) as { messages: { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] | null }[]; tools?: { function: { parameters: { properties: Record<string, unknown> } } }[] }
        const props = input.tools?.[0]?.function.parameters.properties ?? {}, content = input.messages.flatMap((m) => typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content ?? [])
        const prompt = content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n'), images = content.filter((c) => c.type === 'image_url')
        const capture = /<mistake-data>\s*([\s\S]*?)\s*<\/mistake-data>/.exec(prompt)
        const data = capture ? JSON.parse(capture[1]) as Record<string, unknown> : {}
        const kind = 'questions' in props ? 'split' : 'cause' in props ? 'diagnose' : 'verdict' in props ? 'check' : 'question' in props ? 'variant' : 'numericAnswer' in props ? 'independent' : 'solve'
        requests.push({ kind, prompt, data, images: images.length })
        if (state.blocked === kind) await new Promise<void>((resolve) => state.release.push(resolve))
        if (state.fail) { response.writeHead(503).end('Controlled fixture failure'); return }
        let output: unknown
        if (kind === 'split') {
          const blocks = (data.blocks ?? []) as OcrBlock[], ocr = String(data.ocr ?? '')
          const imageUrl = images[0]?.image_url?.url ?? '', binary = Buffer.from(imageUrl.split(',')[1] ?? '', 'base64')
          const width = binary.length > 24 ? binary.readUInt32BE(16) : 0
          const physical = width === 1180 || /body|accelerat|resultant|2\s*kg/i.test(ocr), math = width === 1200 || /Solve|5\s*x|25\s*[-−]/i.test(ocr), multi = width === 1220 || (physical && math)
          const regions = (which: 'math' | 'physics'): number[] => blocks.filter((b) => !multi || (which === 'math' ? b.box[1] < 370 : b.box[1] >= 370)).map((b) => b.index)
          output = { questions: [
            ...(math || multi || !physical ? [{ question: MATH_QUESTION, myAnswer: MATH_MY_ANSWER, correctAnswer: '', solution: '', subject: 'math', regions: regions('math') }] : []),
            ...(physical || multi ? [{ question: PHYSICS_QUESTION, myAnswer: PHYSICS_MY_ANSWER, correctAnswer: '6 N', solution: 'F = ma = 2 × 3 = 6 N.', subject: 'physics', regions: regions('physics') }] : [])
          ] }
        } else if (kind === 'solve') output = { answer: '$x=2,3$', solution: '$x^2-5x+6=(x-2)(x-3)=0$，所以 $x=2$ 或 $x=3$。' }
        else if (kind === 'diagnose') {
          const physics = String(data.question).includes('kg'), myAnswer = String(data.myAnswer ?? '')
          const evidence = physics ? 'F = 2 + 3 = 5 N.' : '25 - 24 = 9'
          output = { cause: myAnswer ? physics ? 'method' : 'calculation' : 'unknown', reason: myAnswer ? `“${evidence}”这一步使用了错误的${physics ? '方法' : '运算'}。` : '', evidence: myAnswer ? evidence : '', concepts: [physics ? '牛顿第二定律' : '一元二次方程'] }
        } else if (kind === 'variant') {
          const n = ++state.counter + 6, question = `Solve $x^2 - ${n}x + ${2 * (n - 2)} = 0$.`, answer = `x=2,${n - 2}`
          answers.set(question, answer)
          output = { question, answer, solution: `$(x-2)(x-${n - 2})=0$, hence $x=2,${n - 2}$.`, numericAnswer: null, unit: '' }
        } else if (kind === 'independent') {
          const wrong = state.mismatch > 0
          if (wrong) state.mismatch--
          output = { answer: wrong ? 'x=2,999' : answers.get(String(data.question)) ?? 'x=2,5', numericAnswer: null, unit: '' }
        } else output = { verdict: '受控流程夹具：本题答案正确。', missing: [], wrong: [], suggested: 3 }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `mistake-${requests.length}`, object: 'chat.completion', created: 1, model: 'mistakes-transport-fixture', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: `submit-${requests.length}`, type: 'function', function: { name: 'submit', arguments: JSON.stringify(output) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }))
        if (kind === 'independent' && state.failAfterIndependent !== null && --state.failAfterIndependent === 0) { state.failAfterIndependent = null; state.fail = true }
      } catch { response.writeHead(400).end('Invalid controlled fixture input') }
    })() })
  })
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  const userData = options.userData ?? mkdtempSync(join(tmpdir(), 'jiwei-mistakes-'))
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: { ...process.env, JIWEI_LANG: 'zh-CN', JIWEI_SKIP_ONBOARDING: '1', JIWEI_IMPORT_PROVIDERS_FROM: options.importProviders ?? '' } })
  const page = await app.firstWindow(); await page.waitForSelector('nav')
  if (!process.env.JIWEI_OCR) await app.evaluate(({ app }, directory) => app.setPath('appData', directory), mkdtempSync(join(tmpdir(), 'jiwei-mistakes-models-')))
  // 错题传输夹具不处理收件箱整理；隔离 21:00 后的自动整理，避免无关请求混入取消断言。
  await page.evaluate(async () => {
    const settings = await window.jiwei.settings.get()
    await window.jiwei.settings.set({ capture: { ...settings.capture, daily: false } })
  })
  if (options.provider !== false) {
    const baseUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`
    await page.evaluate(async (baseUrl) => {
      const p = await window.jiwei.providers.save({ kind: 'ollama', name: 'Mistakes transport fixture', baseUrl, models: ['mistakes-transport-fixture'], modelCaps: { 'mistakes-transport-fixture': { vision: true, tier: 'basic' } } }), s = await window.jiwei.settings.get()
      await window.jiwei.settings.set({ ai: { ...s.ai, chat: { providerId: p.id, model: 'mistakes-transport-fixture' }, embedding: { mode: 'cloud', providerId: null, model: null }, effort: 'off' }, theme: 'light' })
    }, baseUrl)
  }
  const dimensions = process.env.JIWEI_TEST_WINDOW?.split('x').map(Number)
  if (dimensions?.length === 2) await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), dimensions)
  await page.reload(); await page.waitForSelector('nav')
  return { app, page, userData, provider, requests, state, close: async () => { state.release.forEach((release) => release()); await app.close(); await new Promise<void>((resolve) => provider.close(() => resolve())) } }
}
export async function waitMistake(env: MistakesApp, id: string, timeout = 30000): Promise<Mistake> {
  await expect.poll(() => env.page.evaluate((id) => window.jiwei.mistakes.get(id).then((m) => !m?.flags.includes('processing') && !m?.flags.includes('failed')), id), { timeout }).toBe(true)
  return (await env.page.evaluate((id) => window.jiwei.mistakes.get(id), id))!
}
export async function openMistakes(env: MistakesApp): Promise<void> {
  await env.page.getByRole('button', { name: /复习/ }).first().click()
  await env.page.getByRole('tab', { name: '错题本', exact: true }).click()
  await expect(env.page.getByTestId('mistakes-view')).toBeVisible()
}
export async function addImage(env: MistakesApp, kind: 'math' | 'physics' | 'multi', files: ReturnType<typeof import('./mistakes-images').makeMistakeImages>): Promise<Mistake[]> {
  const assetId = await env.page.evaluate(async ({ bytes, name }) => (await window.jiwei.assets.importBytes(name, 'image/png', new Uint8Array(bytes))).id, { bytes: [...files[kind].bytes], name: `mistakes-${kind}.png` })
  const created = await env.page.evaluate(async (assetId) => {
    const inbox = await window.jiwei.inbox.create({ kind: 'photo', text: '', assetId, origin: {} })
    return window.jiwei.mistakes.fromInbox(inbox.id)
  }, assetId)
  const timeout = process.env.JIWEI_IMPORT_PROVIDERS_FROM ? 240000 : process.env.JIWEI_OCR ? 180000 : 30000
  await waitMistake(env, created.items[0].id, timeout)
  await expect.poll(() => env.page.evaluate((id) => window.jiwei.jobs.list().then((jobs) => jobs.find((j) => j.id === id)?.status), created.jobId), { timeout }).toBe('done')
  return env.page.evaluate((key) => window.jiwei.mistakes.list().then((m) => m.filter((m) => m.ingestKey?.startsWith(key))), created.items[0].ingestKey!.replace(/:0$/, ':'))
}
export async function mistakeShot(env: MistakesApp, name: string): Promise<void> {
  if (!process.env.SHOTS_DIR) return
  mkdirSync(process.env.SHOTS_DIR, { recursive: true })
  await env.page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map(async (img) => { if (img.currentSrc) await img.decode() }))
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
  const images = await env.page.locator('[data-testid="mistake-details"] img').evaluateAll((elements) => elements.flatMap((element) => {
    const img = element as HTMLImageElement, rect = img.getBoundingClientRect()
    return !img.closest('[aria-hidden="true"]') && rect.width > 200 && rect.height > 80 && rect.top >= 0 && rect.bottom <= innerHeight
      ? [{ x: rect.x + 10, y: rect.y + 10, width: rect.width - 20, height: rect.height - 20 }] : []
  }))
  for (let attempt = 0; attempt < 4; attempt++) {
    const bytes = await env.page.screenshot({ fullPage: true, animations: 'disabled' })
    const screenshot = await loadImage(bytes), canvas = createCanvas(screenshot.width, screenshot.height), ctx = canvas.getContext('2d')
    ctx.drawImage(screenshot, 0, 0)
    const scale = screenshot.width / await env.page.evaluate(() => innerWidth)
    // 三张已知黑字题图：截图只剩白底时保存原帧并重取，不把未绘制帧作为审查证据。
    const painted = images.every((rect) => {
      const pixels = ctx.getImageData(Math.round(rect.x * scale), Math.round(rect.y * scale), Math.round(rect.width * scale), Math.round(rect.height * scale)).data
      let ink = 0
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 85 && pixels[i + 1] < 85 && pixels[i + 2] < 85) ink++
      return ink / (pixels.length / 4) > 0.002
    })
    if (painted) { writeFileSync(join(process.env.SHOTS_DIR, name), bytes); return }
    writeFileSync(join(process.env.SHOTS_DIR, name.replace(/\.png$/, `-unpainted-${attempt + 1}.png`)), bytes)
    await env.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  }
  throw new Error(`Screenshot did not paint the known question image: ${name}`)
}
export function semanticEvidence(name: string, data: unknown): void {
  const directory = process.env.SHOTS_DIR
  if (!directory) return
  mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, name), JSON.stringify(data, null, 2))
}
/** 只读取本用例隔离库的错题任务结果；从不查询 providers/settings 或生产库。 */
export async function mistakeJobEvidence(env: MistakesApp): Promise<unknown[]> {
  return env.app.evaluate(({ app }) => {
    const path = process.getBuiltinModule('path')
    const requireFromApp = process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(), 'package.json'))
    const Database = requireFromApp('better-sqlite3') as typeof import('better-sqlite3')
    const db = new Database(path.join(app.getPath('userData'), 'data', 'jiwei.db'), { readonly: true })
    try {
      return db.prepare("SELECT id,kind,status,error,attempts,run_after,created_at,updated_at,dedupe_key,result FROM jobs WHERE kind IN ('mistake-split','mistake-variants') ORDER BY created_at").all().map((row) => {
        const r = row as { kind: string; status: string; result: string | null }
        return { ...r, result: r.result ? JSON.parse(r.result) as unknown : null }
      })
    } finally { db.close() }
  })
}
