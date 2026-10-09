import { spawn, type ChildProcess } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { nativeImage } from 'electron'
import { and, eq, inArray } from 'drizzle-orm'
import { generateText } from 'ai'
import log from 'electron-log/main'
import { getDb } from '../db'
import { assets, jobs, sourcePages, sources } from '../db/schema'
import { download } from './download'
import { ensureRuntime, freePort, llamaSupported, modelsDir, runtimeDownloadSize } from './ai/localEmbedding'
import { assetPath } from './assets'
import { emit } from '../events'
import { enqueue, registerJobKind, type JobContext } from './jobs'
import { listSegments, replaceSegments } from './segments'
import { requestIndex } from './ai/indexer'
import { getSettings } from './settings'
import { capsFor, getProviderRow } from './ai/providers'
import { buildModel } from './ai/model'
import {
  extractTables,
  groundedText,
  isDegenerate,
  mergeRecognized,
  normalizeRecognized,
  parseGrounding,
  withCaptions,
  type GroundBlock,
  type RecognizedNeed
} from '../lib/recognized'
import type { RecognizerStatus, SourceRecognition } from '@shared/types'

// 文档识别（v0.5.2 起，设计见 docs/design/v0.5.2-document-recognition.md）：
//   - 解析时按页分流（扫描页 / 表格页 / 图页），只识别文字层不够用的页
//   - 本地引擎：LightOnOCR-3（Apache 2.0，v0.5.4 起；0.8B 快速 / 4B 高精度）由 llama-server 运行，
//     与向量模型共用 llama.cpp 运行时；按需启动，空闲 2 分钟后退出（不常驻）。
//     使用 grounding 模式：每个版面块带类型与坐标，插图给出简短描述，图表给出数据表
//   - 云端引擎：已配置的能看图的模型
//   - 结果缓存在 source_pages（含版面块），并作为附加分段并入资料，进入知识库

const MS = 'https://www.modelscope.cn/models'
const HFM = 'https://hf-mirror.com'
const HF = 'https://huggingface.co'

interface ModelFile {
  file: string
  size: number
  sha256: string
}
interface LocalModel {
  name: string
  repo: string
  model: ModelFile
  mmproj: ModelFile
}

/** 本地识别模型（社区 GGUF 转换，sha256 与 ModelScope 记录一致；实测见设计文档 §3.1） */
export const LOCAL_MODELS: Record<'fast' | 'accurate', LocalModel> = {
  fast: {
    name: 'LightOnOCR-3-0.8B',
    repo: 'prithivMLmods/LightOnOCR-3-0.8B-GGUF',
    model: {
      file: 'LightOnOCR-3-0.8B.Q8_0.gguf',
      size: 811843680,
      sha256: '660a8931ba33c8a604076f69b8785b36eadcdb1cc90004e9f89bf67615a0456d'
    },
    mmproj: {
      file: 'LightOnOCR-3-0.8B.mmproj-q8_0.gguf',
      size: 115923776,
      sha256: 'a8b9b3b01b6c780747b48e0807ef5b753c54f27aa4c23962c3c7d5ace2ed0233'
    }
  },
  accurate: {
    name: 'LightOnOCR-3-4B',
    repo: 'prithivMLmods/LightOnOCR-3-4B-GGUF',
    model: {
      file: 'LightOnOCR-3-4B.Q4_K_M.gguf',
      size: 2708804544,
      sha256: '65a9f78fd67102aeffa98790b3e3eeb33855ded764f94d1cdb42fd0532dda497'
    },
    mmproj: {
      file: 'LightOnOCR-3-4B.mmproj-q8_0.gguf',
      size: 366894656,
      sha256: 'fd5acde1a7a7439b3f9a720d3cead67378beeaabbecc57fe4b30a7f9b301b102'
    }
  }
}
/** v0.5.2–v0.5.3 使用的第二代模型：安装第三代后删除，释放空间 */
const LEGACY_FILES = ['LightOnOCR-2-1B-Q8_0.gguf', 'mmproj-LightOnOCR-2-1B-Q8_0.gguf']

const dir = (): string => join(modelsDir(), 'ocr')
const filePath = (f: { file: string }): string => join(dir(), f.file)
const IDLE_MS = Number(process.env.JIWEI_OCR_IDLE_MS ?? 120_000)
/** 官方建议：页面图像长边 2048 像素 */
const PAGE_SIDE = 2048

export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'heic', 'bmp', 'gif', 'avif'])

/* ——— 设置 ——— */

export type RecognitionSettings = NonNullable<ReturnType<typeof getSettings>['ai']['recognition']>
export function recognitionSettings(): RecognitionSettings {
  return getSettings().ai.recognition ?? { mode: 'local', providerId: null, model: null, auto: true, figures: true, localModel: 'fast' }
}
const localModel = (): LocalModel => LOCAL_MODELS[recognitionSettings().localModel ?? 'fast']

/** 云端看图模型：设置中指定的，否则默认对话模型（能看图时），否则同一服务商中能看图的模型 */
function visionModel(): { providerId: string; model: string } | null {
  const r = recognitionSettings()
  if (r.providerId && r.model) return capsFor(r.providerId, r.model).vision ? { providerId: r.providerId, model: r.model } : null
  const chat = getSettings().ai.chat
  if (!chat.providerId) return null
  try {
    const row = getProviderRow(chat.providerId)
    const models = [chat.model, ...(JSON.parse(row.models) as string[])].filter((m): m is string => !!m)
    const m = models.find((x) => capsFor(chat.providerId, x).vision)
    return m ? { providerId: chat.providerId, model: m } : null
  } catch {
    return null
  }
}

/* ——— 本地模型：安装与状态 ——— */

const installed = (m: LocalModel = localModel()): boolean => [m.model, m.mmproj].every((f) => existsSync(filePath(f)))

let status: RecognizerStatus = { state: 'missing', progress: 0, mirror: null, speed: null, message: null, size: 0, running: false }
const setStatus = (patch: Partial<RecognizerStatus>): void => {
  status = { ...status, ...patch }
  emit('recognition:status', status)
}

export async function recognizerStatus(): Promise<RecognizerStatus> {
  const m = localModel()
  if (status.state !== 'downloading' && status.state !== 'error') status = { ...status, state: installed(m) ? 'ready' : 'missing' }
  const size = status.state === 'ready' ? 0 : m.model.size + m.mmproj.size + (await runtimeDownloadSize())
  return { ...status, size, running: !!proc, model: m.name }
}

let installing: Promise<void> | null = null

/** 下载 llama.cpp 运行时（若尚未安装）与当前选择的识别模型，sha256 校验 */
export function installRecognizer(): Promise<void> {
  if (installing) return installing
  installing = (async () => {
    if (!llamaSupported()) throw new Error(`暂不支持此平台：${process.platform}-${process.arch}`)
    const m = localModel()
    const runtime = await runtimeDownloadSize()
    const total = runtime + m.model.size + m.mmproj.size
    const done = new Map<string, number>()
    const report = (key: string) => (p: { received: number; speed: number; mirror: string }) => {
      done.set(key, p.received)
      const sum = [...done.values()].reduce((a, b) => a + b, 0)
      setStatus({ state: 'downloading', progress: Math.min(0.999, sum / total), mirror: p.mirror, speed: p.speed, message: null })
    }
    try {
      setStatus({ state: 'downloading', progress: 0, message: null })
      await ensureRuntime(report('runtime'))
      for (const [key, f] of [
        ['model', m.model],
        ['mmproj', m.mmproj]
      ] as const)
        await download(
          {
            name: f.file,
            size: f.size,
            sha256: f.sha256,
            urls: [
              `${MS}/${m.repo}/resolve/master/${f.file}`,
              `${HFM}/${m.repo}/resolve/main/${f.file}`,
              `${HF}/${m.repo}/resolve/main/${f.file}`
            ],
            dest: filePath(f)
          },
          report(key)
        )
      for (const f of LEGACY_FILES) rmSync(join(dir(), f), { force: true })
      setStatus({ state: 'ready', progress: 1, mirror: null, speed: null, message: null })
      queuePending()
    } catch (e) {
      setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) })
      throw e
    }
  })().finally(() => {
    installing = null
  })
  return installing
}

/* ——— 本地模型：按需运行 ——— */

let proc: ChildProcess | null = null
let procModel: string | null = null
let port = 0
/** 服务已通过健康检查（进程启动到模型加载完成之间为 false） */
let ready = false
let starting: Promise<void> | null = null
let idleTimer: NodeJS.Timeout | null = null
/** 进行中的识别请求数：有请求时不计空闲 */
let inflight = 0

function touchIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (inflight > 0) return
  idleTimer = setTimeout(() => {
    log.info('[ocr] idle, stopping llama-server')
    stopRecognizer()
  }, IDLE_MS)
}

async function startServer(): Promise<void> {
  const m = localModel()
  // 换了模型：重启服务
  if (proc && ready && procModel !== m.name && inflight <= 1) stopRecognizer()
  if (starting) return starting
  if (proc && ready) return
  starting = (async () => {
    const bin = await ensureRuntime(() => {})
    port = await freePort()
    // 上下文：一页图像约 2800 个词元 + 输出最多 4096；按官方要求关闭思考
    const args = ['-m', filePath(m.model), '--mmproj', filePath(m.mmproj), '--host', '127.0.0.1', '--port', String(port)]
    args.push('-c', '12288', '-np', '1', '--no-webui', '--jinja', '--chat-template-kwargs', '{"enable_thinking":false}')
    log.info('[ocr] starting llama-server', m.name, 'on', port)
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    proc = child
    procModel = m.name
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)))
    child.on('exit', (code) => {
      log.info('[ocr] llama-server exited', code)
      if (proc === child) {
        proc = null
        port = 0
        ready = false
        setStatus({ running: false })
      }
    })
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 250))
      if (proc !== child) throw new Error(`识别模型启动失败：${stderr.slice(-300)}`)
      const ok = await fetch(`http://127.0.0.1:${port}/health`).then(
        (r) => r.ok,
        () => false
      )
      if (ok) {
        ready = true
        setStatus({ running: true })
        return
      }
    }
    stopRecognizer()
    throw new Error('识别模型启动超时')
  })().finally(() => {
    starting = null
  })
  return starting
}

export function stopRecognizer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  proc?.kill()
  proc = null
  procModel = null
  port = 0
  ready = false
  setStatus({ running: false })
}
process.on('exit', () => proc?.kill())

async function recognizeLocal(jpeg: Uint8Array, signal: AbortSignal, grounding = true): Promise<string> {
  inflight++
  touchIdle()
  try {
    await startServer()
    return await requestLocal(jpeg, signal, grounding)
  } finally {
    inflight--
    touchIdle()
  }
}

/**
 * 采样（温度 0.2）偶尔陷入重复输出：重新识别，最多 3 次；仍然重复时改用普通转写模式（不带版面块）。
 * PMBOK 实测：143 页中有 1 页在 grounding 模式下偶发重复，单独重试即正常。
 */
async function recognizeLocalRobust(jpeg: Uint8Array, signal: AbortSignal): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const raw = await recognizeLocal(jpeg, signal)
    if (!isDegenerate(raw)) return raw
    log.warn('[ocr] degenerate output, retrying', i + 1)
  }
  const plain = await recognizeLocal(jpeg, signal, false)
  if (isDegenerate(plain)) throw new Error('识别结果异常（大量重复字符）')
  return plain
}

async function requestLocal(jpeg: Uint8Array, signal: AbortSignal, grounding = true): Promise<string> {
  // 服务刚启动时 /health 已就绪但视觉模块可能仍在加载（HTTP 503 Loading model）：稍等重试
  for (let i = 0; ; i++) {
    try {
      return await requestLocalOnce(jpeg, signal, grounding)
    } catch (e) {
      if (!(e instanceof LoadingError) || i >= 60 || signal.aborted) throw e
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}

class LoadingError extends Error {}

async function requestLocalOnce(jpeg: Uint8Array, signal: AbortSignal, grounding: boolean): Promise<string> {
  // grounding 模式（官方的两种用法之一）：每块带类型与坐标；参数按官方建议
  // 单页最长 5 分钟（慢机器 CPU 推理）；服务进程意外退出时请求会立即失败
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
    body: JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}` } },
            ...(grounding ? [{ type: 'text', text: 'grounding' }] : [])
          ]
        }
      ],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 4096
    })
  })
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200)
    if (res.status === 503 && /loading/i.test(text)) throw new LoadingError(text)
    throw new Error(`识别模型出错：HTTP ${res.status} ${text}`)
  }
  const body = (await res.json()) as { choices: { message: { content: string } }[] }
  return body.choices[0]?.message.content ?? ''
}

/**
 * 框选提问：当前模型不能看图时，先用本地模型识别框选区域（文字、表格、插图描述）。
 * 本地模型未下载或已关闭时返回 null。
 */
export async function recognizeRegion(dataUrl: string): Promise<string | null> {
  if (recognitionSettings().mode === 'off' || !installed()) return null
  const m = /^data:image\/[a-z+]+;base64,(.+)$/.exec(dataUrl)
  if (!m) return null
  try {
    const raw = await recognizeLocalRobust(new Uint8Array(Buffer.from(m[1], 'base64')), AbortSignal.timeout(90_000))
    const blocks = parseGrounding(raw)
    return (blocks.length ? groundedText(blocks, 'scan') : normalizeRecognized(raw)).trim() || null
  } catch (e) {
    log.warn('[ocr] region failed', e)
    return null
  }
}

/* ——— 云端看图模型 ——— */

const PROMPTS: Record<RecognizedNeed, string> = {
  scan: '这是一页扫描或拍照的资料。把页面上的全部文字按阅读顺序逐字转写为 Markdown：保留标题层级和列表；表格用 Markdown 表格逐格还原；公式用 LaTeX。只转写看得到的内容，不总结、不补充、不翻译。',
  table:
    '这一页的正文已经有文字版了，不用转写正文。只把页面中的表格逐格还原为 Markdown 表格，每张表之前写上它的表号和标题（如“表2-1。 ……”）。只写看得到的内容。',
  figure:
    '这一页的正文已经有文字版了，不用转写正文。只说明页面中的图：先写图号和标题，再用几句话说明图的结构——有哪些组成部分、谁包含谁、箭头表示的先后或因果关系、坐标轴与数据趋势。只写图中确实能看到的内容，不要补充图外的知识；看不清的地方直接说看不清。'
}

async function recognizeCloud(jpeg: Uint8Array, need: RecognizedNeed, signal: AbortSignal): Promise<{ text: string; engine: string }> {
  const vm = visionModel()
  if (!vm) throw new Error('没有能看图的云端模型：请在设置 → AI 中为模型打开“看图”，或改用本地识别')
  const built = buildModel({ providerId: vm.providerId, model: vm.model, effort: 'off' })
  const r = await generateText({
    model: built.model,
    providerOptions: built.providerOptions as never,
    maxOutputTokens: 4000,
    temperature: 0,
    abortSignal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', image: jpeg, mediaType: 'image/jpeg' },
          { type: 'text', text: PROMPTS[need] }
        ]
      }
    ]
  })
  return { text: r.text, engine: `cloud:${vm.model}` }
}

/* ——— 页面图像 ——— */

async function pageImage(path: string, ext: string, page: number, ctx: JobContext): Promise<Uint8Array> {
  if (ext === 'pdf') return ctx.worker<Uint8Array>('renderPdfPage', { path, page, maxSide: PAGE_SIDE })
  // 图片资料：系统解码（macOS 支持 HEIC），长边缩到 2048 像素以内
  let img = nativeImage.createFromPath(path)
  if (img.isEmpty()) throw new Error(`无法读取图片：${ext}`)
  const { width, height } = img.getSize()
  const scale = Math.min(1, PAGE_SIDE / Math.max(width, height))
  if (scale < 1) img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' })
  return new Uint8Array(img.toJPEG(88))
}

/* ——— 资料的待识别页 ——— */

/** 解析后登记需要识别的页：类型没变且已识别的页保留结果，不再出现的页删除 */
export function recordPages(sourceId: string, pages: { page: number; need: RecognizedNeed }[]): void {
  const db = getDb()
  const prev = new Map(
    db
      .select()
      .from(sourcePages)
      .where(eq(sourcePages.sourceId, sourceId))
      .all()
      .map((r) => [r.page, r])
  )
  const now = Date.now()
  db.transaction((tx) => {
    for (const p of pages) {
      const old = prev.get(p.page)
      prev.delete(p.page)
      if (old && old.need === p.need) continue
      tx.insert(sourcePages)
        .values({ sourceId, page: p.page, need: p.need, status: 'pending', updatedAt: now })
        .onConflictDoUpdate({
          target: [sourcePages.sourceId, sourcePages.page],
          set: { need: p.need, status: 'pending', text: null, engine: null, error: null, updatedAt: now }
        })
        .run()
    }
    if (prev.size)
      tx.delete(sourcePages)
        .where(and(eq(sourcePages.sourceId, sourceId), inArray(sourcePages.page, [...prev.keys()])))
        .run()
  })
  emit('recognition:source', { sourceId })
}

/** 已识别的结果并入资料分段（保留原有分段 ID） */
export function applyRecognized(sourceId: string): number {
  const recs = getDb()
    .select()
    .from(sourcePages)
    .where(and(eq(sourcePages.sourceId, sourceId), eq(sourcePages.status, 'done')))
    .all()
    .filter((r) => r.text?.trim())
    .map((r) => ({ page: r.page, need: r.need, text: r.text! }))
  const current = listSegments(sourceId)
  if (!recs.length && !current.some((s) => s.kind.startsWith('ocr:'))) return 0
  const n = replaceSegments(sourceId, mergeRecognized(current, recs))
  requestIndex()
  return n
}

const aiExcluded = (sourceId: string): boolean =>
  !!getDb().select({ x: sources.aiExcluded }).from(sources).where(eq(sources.id, sourceId)).get()?.x

/** 本次设置下要处理的类型；插图解读走云端，“不发送给 AI”的资料不解读 */
function wantedNeeds(sourceId: string): RecognizedNeed[] {
  const r = recognitionSettings()
  if (r.mode === 'off') return []
  const needs: RecognizedNeed[] = ['scan', 'table']
  // 插图：本地模型给出简短描述（不出电脑）；云端需要能看图的模型，“不发送给 AI”的资料不上传
  if (r.figures && (r.mode === 'local' || (visionModel() && !aiExcluded(sourceId)))) needs.push('figure')
  return needs
}

function engineState(sourceId: string): SourceRecognition['engine'] {
  const r = recognitionSettings()
  if (r.mode === 'off') return 'off'
  if (r.mode === 'cloud' && aiExcluded(sourceId)) return 'excluded'
  if (r.mode === 'local' && !installed()) return 'needs-install'
  if (r.mode === 'cloud' && !visionModel()) return 'no-vision-model'
  return 'ready'
}

export function sourceRecognition(sourceId: string): SourceRecognition {
  const rows = getDb().select().from(sourcePages).where(eq(sourcePages.sourceId, sourceId)).all()
  const wanted = new Set(wantedNeeds(sourceId))
  const needs = { scan: 0, table: 0, figure: 0 }
  for (const r of rows) needs[r.need]++
  const mine = rows.filter((r) => wanted.has(r.need) || r.status === 'done')
  const job = getDb()
    .select({ status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.dedupeKey, `recognize:${sourceId}`), inArray(jobs.status, ['queued', 'running'])))
    .get()
  return {
    needs,
    total: mine.length,
    done: mine.filter((r) => r.status === 'done' || r.status === 'skipped').length,
    failed: mine.filter((r) => r.status === 'failed').length,
    running: !!job,
    engine: engineState(sourceId)
  }
}

/** 开始识别一份资料（后台任务）；failed 的页一并重试 */
export function startRecognition(sourceId: string): void {
  const state = engineState(sourceId)
  if (state !== 'ready') throw new Error(`当前无法识别：${state}`)
  getDb()
    .update(sourcePages)
    .set({ status: 'pending', error: null, updatedAt: Date.now() })
    .where(and(eq(sourcePages.sourceId, sourceId), eq(sourcePages.status, 'failed')))
    .run()
  enqueue('source.recognize', { sourceId }, { dedupeKey: `recognize:${sourceId}` })
  emit('recognition:source', { sourceId })
}

/** 解析完成后：开启了自动识别且引擎就绪时排队 */
export function maybeAutoRecognize(sourceId: string): void {
  if (!recognitionSettings().auto || engineState(sourceId) !== 'ready') return
  const wanted = wantedNeeds(sourceId)
  const pending = getDb()
    .select({ page: sourcePages.page })
    .from(sourcePages)
    .where(and(eq(sourcePages.sourceId, sourceId), eq(sourcePages.status, 'pending'), inArray(sourcePages.need, wanted)))
    .get()
  if (pending) enqueue('source.recognize', { sourceId }, { dedupeKey: `recognize:${sourceId}` })
}

/** 模型下载完成或设置变化后：为所有有待识别页的资料排队（仅自动识别开启时） */
export function queuePending(): void {
  if (!recognitionSettings().auto) return
  const ids = getDb().selectDistinct({ id: sourcePages.sourceId }).from(sourcePages).where(eq(sourcePages.status, 'pending')).all()
  for (const { id } of ids) maybeAutoRecognize(id)
}

/** 某页文字层的全文（不含识别分段） */
function pageText(sourceId: string, page: number): string {
  return listSegments(sourceId)
    .filter((s) => !s.kind.startsWith('ocr:') && (s.locator as { value?: string }).value === `page=${page}`)
    .map((s) => s.text)
    .join('\n')
}

/* ——— 后台任务 ——— */

/** 正在识别的资料：同一资料不并行识别（避免重复处理同一页） */
const activeSources = new Set<string>()

export function registerRecognizeJob(): void {
  registerJobKind<{ sourceId: string }>('source.recognize', {
    title: ({ sourceId }) =>
      `识别资料：${getDb().select({ title: sources.title }).from(sources).where(eq(sources.id, sourceId)).get()?.title ?? sourceId}`,
    async run({ sourceId }, ctx) {
      const row = getDb()
        .select({ s: sources, a: assets })
        .from(sources)
        .leftJoin(assets, eq(sources.assetId, assets.id))
        .where(eq(sources.id, sourceId))
        .get()
      if (!row?.a || row.s.deletedAt) return { skipped: 'no file' }
      const state = engineState(sourceId)
      if (state !== 'ready') return { skipped: state }
      if (activeSources.has(sourceId)) return { skipped: 'already running' }
      activeSources.add(sourceId)
      try {
        return await recognizeSource(sourceId, row.a, ctx)
      } finally {
        activeSources.delete(sourceId)
      }
    }
  })
}

async function recognizeSource(
  sourceId: string,
  a: { id: string; ext: string },
  ctx: JobContext
): Promise<{ done: number; failed: number }> {
  const mode = recognitionSettings().mode
  const wanted = wantedNeeds(sourceId)
  const todo = getDb()
    .select()
    .from(sourcePages)
    .where(and(eq(sourcePages.sourceId, sourceId), inArray(sourcePages.status, ['pending', 'failed']), inArray(sourcePages.need, wanted)))
    .all()
    .sort((x, y) => x.page - y.page)
  const path = assetPath(a.id, a.ext)
  const abort = new AbortController()
  let done = 0
  let failed = 0
  let sinceApply = 0
  for (const p of todo) {
    if (ctx.isCanceled()) {
      abort.abort()
      break
    }
    const set = (patch: Partial<typeof sourcePages.$inferInsert>): void => {
      getDb()
        .update(sourcePages)
        .set({ ...patch, updatedAt: Date.now() })
        .where(and(eq(sourcePages.sourceId, sourceId), eq(sourcePages.page, p.page)))
        .run()
    }
    try {
      const jpeg = await pageImage(path, a.ext, p.page, ctx)
      let text: string
      let engine: string
      let blocks: GroundBlock[] | null = null
      if (mode === 'cloud') {
        const r = await recognizeCloud(jpeg, p.need, abort.signal)
        if (isDegenerate(r.text)) throw new Error('识别结果异常（大量重复字符）')
        engine = r.engine
        text = normalizeRecognized(r.text)
        if (p.need === 'table') text = extractTables(text)
      } else {
        // 本地 LightOnOCR-3：grounding 输出按页面类型整理（插图为简短描述，图表为数据表）
        const raw = await recognizeLocalRobust(jpeg, abort.signal)
        engine = `local:${localModel().name}`
        blocks = parseGrounding(raw)
        text = blocks.length ? groundedText(blocks, p.need) : normalizeRecognized(raw)
      }
      if (p.need === 'table') text = withCaptions(text, pageText(sourceId, p.page))
      set({ status: text ? 'done' : 'skipped', text: text || null, engine, blocks: blocks ? JSON.stringify(blocks) : null, error: null })
      done++
      sinceApply++
    } catch (e) {
      if (ctx.isCanceled()) break
      const msg = e instanceof Error ? e.message : String(e)
      log.warn('[ocr] page failed', sourceId, p.page, msg)
      set({ status: 'failed', error: msg.slice(0, 500) })
      failed++
    }
    ctx.progress((done + failed) / todo.length)
    emit('recognition:source', { sourceId })
    // 边识别边进入知识库：每 10 页并入一次
    if (sinceApply >= 10) {
      applyRecognized(sourceId)
      sinceApply = 0
    }
  }
  applyRecognized(sourceId)
  emit('recognition:source', { sourceId })
  if (failed && !done) throw new Error(`识别失败（${failed} 页）`)
  return { done, failed }
}

/** 删除本地识别模型（释放空间） */
export function removeRecognizer(): void {
  stopRecognizer()
  for (const m of Object.values(LOCAL_MODELS)) for (const f of [m.model, m.mmproj]) rmSync(filePath(f), { force: true })
  for (const f of LEGACY_FILES) rmSync(join(dir(), f), { force: true })
  setStatus({ state: 'missing', progress: 0 })
}
