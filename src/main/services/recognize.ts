import { spawn, type ChildProcess } from 'child_process'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { nativeImage } from 'electron'
import { and, eq, gte, inArray, lte } from 'drizzle-orm'
import { generateText } from 'ai'
import log from 'electron-log/main'
import { getDb } from '../db'
import { assets, jobs, jobSteps, sourcePages, sources } from '../db/schema'
import { FORMATS } from '@shared/formats'
import { download } from './download'
import { ensureRuntime, freePort, llamaSupported, modelsDir, runtimeDownloadSize } from './ai/localEmbedding'
import { assetPath } from './assets'
import { emit } from '../events'
import { enqueue, JobDeferred, PermanentJobError, patchQueuedPayload, registerJobKind, runJobNow, type JobContext } from './jobs'
import { listSegments, replaceSegments } from './segments'
import { sourceJobTitle } from './sourceJobTitle'
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
import { queueNoteImages, registerNoteImageJob } from './noteImages'
import { z } from 'zod'
import type { JobWaiting, RegionRecognition, ScanPageText, RecognizerStatus, SourceRecognition } from '@shared/types'

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

// SVG 保持原来不进入光栅识别的约定。
export const IMAGE_EXTS = new Set(
  Object.entries(FORMATS)
    .filter(([ext, info]) => info.kind === 'image' && ext !== 'svg')
    .map(([ext]) => ext)
)

/* ——— 设置 ——— */

export type RecognitionSettings = NonNullable<ReturnType<typeof getSettings>['ai']['recognition']>
export function recognitionSettings(): RecognitionSettings {
  return getSettings().ai.recognition ?? { mode: 'local', providerId: null, model: null, auto: true, figures: true, localModel: 'fast' }
}
const localModel = (): LocalModel => LOCAL_MODELS[recognitionSettings().localModel ?? 'fast']

/** 云端看图模型：设置中指定的，否则默认对话模型（能看图时），否则同一服务商中能看图的模型 */
export function visionModel(): { providerId: string; model: string } | null {
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

export const localRecognizerInstalled = (m: LocalModel = localModel()): boolean => [m.model, m.mmproj].every((f) => existsSync(filePath(f)))

let status: RecognizerStatus = { state: 'missing', progress: 0, mirror: null, speed: null, message: null, size: 0, running: false }
const setStatus = (patch: Partial<RecognizerStatus>): void => {
  status = { ...status, ...patch }
  emit('recognition:status', status)
}

export async function recognizerStatus(): Promise<RecognizerStatus> {
  const m = localModel()
  if (status.state !== 'downloading' && status.state !== 'error')
    status = { ...status, state: localRecognizerInstalled(m) ? 'ready' : 'missing' }
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
  return (await recognizeRegionDetailed(dataUrl))?.text ?? null
}

export async function recognizeRegionDetailed(dataUrl: string): Promise<RegionRecognition | null> {
  if (recognitionSettings().mode === 'off' || !localRecognizerInstalled()) return null
  if (dataUrl.length > 36 * 1024 * 1024) return null
  const m = /^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
  if (!m) return null
  try {
    const raw = await recognizeLocalRobust(new Uint8Array(Buffer.from(m[1], 'base64')), AbortSignal.timeout(90_000))
    const blocks = parseGrounding(raw)
    const text = (blocks.length ? groundedText(blocks, 'scan') : normalizeRecognized(raw)).trim()
    return text ? { text, blocks, engine: localModel().name } : null
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
export function recordPages(sourceId: string, pages: { page: number; need: RecognizedNeed; error?: string }[]): void {
  const db = getDb()
  const prev = new Map(
    db
      .select()
      .from(sourcePages)
      .where(eq(sourcePages.sourceId, sourceId))
      .all()
      .map((r) => [`${r.page}:${r.need}`, r])
  )
  const now = Date.now()
  db.transaction((tx) => {
    for (const p of pages) {
      const key = `${p.page}:${p.need}`
      const old = prev.get(key)
      prev.delete(key)
      if (old && old.need === p.need) {
        if (old.status !== 'done' && old.status !== 'skipped' && (p.error || old.error?.startsWith('Page detection failed:')))
          tx.update(sourcePages)
            .set({ status: p.error ? 'failed' : 'pending', error: p.error ?? null, updatedAt: now })
            .where(and(eq(sourcePages.sourceId, sourceId), eq(sourcePages.page, p.page), eq(sourcePages.need, p.need)))
            .run()
        continue
      }
      tx.insert(sourcePages)
        .values({ sourceId, page: p.page, need: p.need, status: p.error ? 'failed' : 'pending', error: p.error ?? null, updatedAt: now })
        .onConflictDoUpdate({
          target: [sourcePages.sourceId, sourcePages.page, sourcePages.need],
          set: { need: p.need, status: p.error ? 'failed' : 'pending', text: null, engine: null, error: p.error ?? null, updatedAt: now }
        })
        .run()
    }
    // 解析器升级可能不再把该页列为待识别；同一不可变素材的已完成结果仍可复用。
    for (const old of [...prev.values()].filter((r) => r.status !== 'done'))
      tx.delete(sourcePages)
        .where(and(eq(sourcePages.sourceId, sourceId), eq(sourcePages.page, old.page), eq(sourcePages.need, old.need)))
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
  if (r.mode === 'local' && !localRecognizerInstalled()) return 'needs-install'
  if (r.mode === 'cloud' && !visionModel()) return 'no-vision-model'
  return 'ready'
}

interface DigestRange {
  sourceId: string
  fromPage?: number
  toPage?: number
  noWait?: boolean
}

interface RecognitionInput {
  sourceId: string
  full?: true
  /** 新任务显式标记按需语义；旧版本缺少此标记的手动任务仍处理全书。 */
  scoped?: true
  retryPages?: number[]
}
const OUTCOME_PREFIX = 'recognition:page:'
const RecognitionOutcomeSchema = z.object({
  page: z.number().int().positive(),
  need: z.enum(['scan', 'table', 'figure']),
  status: z.enum(['done', 'skipped', 'failed'])
})
type RecognitionOutcome = z.infer<typeof RecognitionOutcomeSchema>
const outcomeKey = (page: { page: number; need: string }): string => `${page.page}:${page.need}`

/** 每页结果与页面状态一起提交，跨让出/重启保留本任务的成功与失败依据。 */
function recognitionOutcomes(jobId: string | undefined, sourceId: string): RecognitionOutcome[] {
  if (!jobId) return []
  const current = new Map(pagesInRange(sourceId).map((page) => [outcomeKey(page), page.status]))
  return getDb()
    .select()
    .from(jobSteps)
    .where(and(eq(jobSteps.jobId, jobId), eq(jobSteps.sourceId, sourceId)))
    .all()
    .filter((row) => row.stepKey.startsWith(OUTCOME_PREFIX))
    .map((row) => {
      const outcome = RecognitionOutcomeSchema.parse(JSON.parse(row.output))
      const status = current.get(outcomeKey(outcome))
      return status === 'done' || status === 'skipped' ? { ...outcome, status } : outcome
    })
}

function retryRecognition(input: RecognitionInput, jobId?: string): void {
  if (!jobId) return
  const outcomes = recognitionOutcomes(jobId, input.sourceId)
  if (input.scoped === true && input.full !== true && !outcomes.length && !input.retryPages?.length)
    throw new PermanentJobError(
      getSettings().language.startsWith('zh')
        ? '识别重试检查点已过期，请从资料重新开始识别'
        : 'The recognition retry checkpoint has expired; start recognition again from the source'
    )
  let failed = outcomes.filter((row) => row.status === 'failed')
  if (!failed.length && (input.scoped !== true || input.full === true || input.retryPages?.length))
    failed = pagesInRange(input.sourceId)
      .filter((row) => row.status === 'failed' && (input.scoped !== true || input.full === true || input.retryPages?.includes(row.page)))
      .map(({ page, need }) => ({ page, need, status: 'failed' as const }))
  for (const page of failed)
    getDb()
      .update(sourcePages)
      .set({ status: 'pending', error: null, updatedAt: Date.now() })
      .where(
        and(
          eq(sourcePages.sourceId, input.sourceId),
          eq(sourcePages.page, page.page),
          eq(sourcePages.need, page.need),
          eq(sourcePages.status, 'failed')
        )
      )
      .run()
  patchQueuedPayload(jobId, { retryPages: [...new Set(failed.map((page) => page.page))] })
  emit('recognition:source', { sourceId: input.sourceId })
}

/** 只认排队且仍需等待的整理，不把运行中的整理反向变成识别依赖。 */
function waitingDigests(sourceId: string): { id: string; payload: DigestRange; createdAt: number }[] {
  return getDb()
    .select({ id: jobs.id, payload: jobs.payload, createdAt: jobs.createdAt })
    .from(jobs)
    .where(and(eq(jobs.kind, 'source.digest'), eq(jobs.status, 'queued')))
    .all()
    .flatMap((row) => {
      try {
        const payload = JSON.parse(row.payload) as DigestRange | null
        return payload?.sourceId === sourceId && payload.noWait !== true ? [{ id: row.id, payload, createdAt: row.createdAt }] : []
      } catch {
        return []
      }
    })
}

export function sourceParsing(sourceId: string): boolean {
  return !!getDb()
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.dedupeKey, `segment:${sourceId}`), inArray(jobs.status, ['queued', 'running'])))
    .get()
}

function pagesInRange(sourceId: string, from?: number, to?: number) {
  return getDb()
    .select()
    .from(sourcePages)
    .where(
      and(
        eq(sourcePages.sourceId, sourceId),
        from === undefined ? undefined : gte(sourcePages.page, from),
        to === undefined ? undefined : lte(sourcePages.page, to)
      )
    )
    .all()
}

/** 同一页可能同时有表格和插图，等待进度按页去重；失败视为已尝试。 */
export function pendingRecognition(sourceId: string, from?: number, to?: number): { pending: number[]; total: number; done: number } {
  const wanted = new Set(wantedNeeds(sourceId))
  const rows = pagesInRange(sourceId, from, to).filter((row) => wanted.has(row.need))
  const all = new Set(rows.map((row) => row.page))
  const pending = new Set(rows.filter((row) => row.status === 'pending').map((row) => row.page))
  return {
    pending: engineState(sourceId) === 'ready' ? [...pending].sort((a, b) => a - b) : [],
    total: all.size,
    done: all.size - pending.size
  }
}

/** 引擎关闭时仍保留原始缺页信息，供确认提示和提案说明使用。 */
export function unrecognizedPages(sourceId: string, from?: number, to?: number, status?: 'pending'): number[] {
  // 只算当前设置本该识别的类型（如未开插图解读时插图页不算缺页）；识别关闭时按扫描页与表格页计。
  const wanted = wantedNeeds(sourceId)
  const needs = new Set<RecognizedNeed>(wanted.length ? wanted : ['scan', 'table'])
  return [
    ...new Set(
      pagesInRange(sourceId, from, to)
        .filter((row) => needs.has(row.need) && (row.status === 'pending' || (!status && row.status === 'failed')))
        .map((row) => row.page)
    )
  ].sort((a, b) => a - b)
}

export function digestWaiting(input: DigestRange): JobWaiting | null {
  if (input.noWait === true) return null
  if (sourceParsing(input.sourceId)) return { reason: 'parsing' }
  const { pending, done, total } = pendingRecognition(input.sourceId, input.fromPage, input.toPage)
  return pending.length ? { reason: 'recognition', done, total } : null
}

/** 用户确认整理后，即使关闭自动识别，也必须有一个任务能处理其范围。 */
export function ensureRecognition(sourceId: string): string | null {
  const active = getDb()
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, 'source.recognize'), eq(jobs.dedupeKey, `recognize:${sourceId}`), inArray(jobs.status, ['queued', 'running'])))
    .get()
  if (active) return active.id
  if (!pendingRecognition(sourceId).pending.length) return null
  return enqueue('source.recognize', { sourceId, scoped: true }, { dedupeKey: `recognize:${sourceId}` })
}

/**
 * 整理确认之后，这份资料的识别已经以取消或失败结束、且没有新的识别在跑：不再等待，
 * 也不替用户重新排识别（取消识别即表示不要识别；失败已用尽自动重试）。
 */
export function recognitionEndedSince(sourceId: string, since: number): boolean {
  const rows = getDb()
    .select({ status: jobs.status, updatedAt: jobs.updatedAt })
    .from(jobs)
    .where(and(eq(jobs.kind, 'source.recognize'), eq(jobs.dedupeKey, `recognize:${sourceId}`)))
    .all()
  if (rows.some((row) => row.status === 'queued' || row.status === 'running')) return false
  return rows.some((row) => (row.status === 'canceled' || row.status === 'failed') && row.updatedAt >= since)
}

/** 分段由整理开始时的 applyRecognized 发布；这里只负责尽早唤醒，避免用户池占满时每页重切分段。 */
export function wakeWaitingDigests(sourceId: string): void {
  const waiting = waitingDigests(sourceId)
  if (!waiting.length || sourceParsing(sourceId)) return
  const ready = waiting.filter(({ payload, createdAt }) => !digestWaiting(payload) || recognitionEndedSince(sourceId, createdAt))
  for (const { id } of ready) runJobNow(id)
  if (ready.length !== waiting.length) ensureRecognition(sourceId)
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
  const id = enqueue('source.recognize', { sourceId, full: true }, { dedupeKey: `recognize:${sourceId}` })
  patchQueuedPayload(id, { full: true })
  emit('recognition:source', { sourceId })
}

/** 解析完成后：开启了自动识别且引擎就绪时排队 */
export function maybeAutoRecognize(sourceId: string): void {
  if (!recognitionSettings().auto || engineState(sourceId) !== 'ready') return
  ensureRecognition(sourceId)
}

/** 模型下载完成或设置变化后：为所有有待识别页的资料排队（仅自动识别开启时） */
export function queuePending(): void {
  queueNoteImages()
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
  registerNoteImageJob()
  registerJobKind<RecognitionInput>('source.recognize', {
    lane: ({ sourceId }) => (waitingDigests(sourceId).length ? 'user' : 'background'),
    offPeak: true,
    onRetry: retryRecognition,
    // 用户取消识别：正在等它的整理改用已有内容立即开始（缺页会写进提案），不重新排识别。
    onCancel: ({ sourceId }) => {
      for (const { id } of waitingDigests(sourceId)) runJobNow(id)
    },
    title: ({ sourceId }) => `识别资料：${sourceJobTitle(sourceId)}`,
    async run({ sourceId, full, scoped, retryPages }, ctx) {
      const row = getDb()
        .select({ s: sources, a: assets })
        .from(sources)
        .leftJoin(assets, eq(sources.assetId, assets.id))
        .where(eq(sources.id, sourceId))
        .get()
      if (!row?.a || row.s.deletedAt) return { skipped: 'no file' }
      const state = engineState(sourceId)
      if (state !== 'ready') return { skipped: state }
      if (activeSources.has(sourceId)) throw new JobDeferred(1000, 'waiting')
      activeSources.add(sourceId)
      try {
        return await recognizeSource(sourceId, row.a, ctx, full === true || scoped !== true, retryPages)
      } finally {
        activeSources.delete(sourceId)
      }
    }
  })
}

async function recognizeSource(
  sourceId: string,
  a: { id: string; ext: string },
  ctx: JobContext,
  full: boolean,
  retryPages: number[] = []
): Promise<{ done: number; failed: number }> {
  const mode = recognitionSettings().mode
  const path = assetPath(a.id, a.ext)
  const abort = new AbortController()
  const outcomes = new Map(recognitionOutcomes(ctx.jobId, sourceId).map((page) => [outcomeKey(page), page]))
  const report = (): { done: number; failed: number } => ({
    done: [...outcomes.values()].filter((page) => page.status !== 'failed').length,
    failed: [...outcomes.values()].filter((page) => page.status === 'failed').length
  })
  const retry = new Set(retryPages)
  let sinceApply = 0
  try {
    while (engineState(sourceId) === 'ready') {
      if (ctx.isCanceled()) {
        abort.abort()
        break
      }
      // 每页重新计算：新确认的范围及时提到前面，取消后不再继续范围外工作。
      const ranges = waitingDigests(sourceId).map(({ payload }) => payload)
      const urgent = (page: number): boolean => ranges.some((range) => page >= (range.fromPage ?? 1) && page <= (range.toPage ?? Infinity))
      const all = full || recognitionSettings().auto
      const wanted = wantedNeeds(sourceId)
      const todo = getDb()
        .select()
        .from(sourcePages)
        .where(and(eq(sourcePages.sourceId, sourceId), eq(sourcePages.status, 'pending'), inArray(sourcePages.need, wanted)))
        .all()
        .filter((page) => all || urgent(page.page) || retry.has(page.page))
        .sort((a, b) => Number(urgent(b.page)) - Number(urgent(a.page)) || a.page - b.page)
      if (!todo.length) break
      const p = todo[0]
      const set = (patch: Partial<typeof sourcePages.$inferInsert>): void => {
        ctx.signal?.throwIfAborted()
        if (ctx.isCanceled()) throw new Error('canceled')
        const db = getDb()
        const outcome = RecognitionOutcomeSchema.parse({ page: p.page, need: p.need, status: patch.status })
        db.transaction(() => {
          db.update(sourcePages)
            .set({ ...patch, updatedAt: Date.now() })
            .where(and(eq(sourcePages.sourceId, sourceId), eq(sourcePages.page, p.page), eq(sourcePages.need, p.need)))
            .run()
          if (ctx.jobId) {
            const output = JSON.stringify(outcome)
            db.insert(jobSteps)
              .values({ jobId: ctx.jobId, stepKey: OUTCOME_PREFIX + outcomeKey(p), sourceId, output, createdAt: Date.now() })
              .onConflictDoUpdate({ target: [jobSteps.jobId, jobSteps.stepKey], set: { output, createdAt: Date.now() } })
              .run()
          }
        })
        outcomes.set(outcomeKey(p), outcome)
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
        sinceApply++
      } catch (e) {
        if (ctx.isCanceled()) break
        const msg = e instanceof Error ? e.message : String(e)
        log.warn('[ocr] page failed', sourceId, p.page, msg)
        set({ status: 'failed', error: msg.slice(0, 500) })
      }
      const { done, failed } = report()
      ctx.progress((done + failed) / (done + failed + todo.length - 1))
      emit('recognition:source', { sourceId })
      // 边识别边进入知识库：每 10 页并入一次
      if (sinceApply >= 10) {
        applyRecognized(sourceId)
        sinceApply = 0
      }
      wakeWaitingDigests(sourceId)
      ctx.yieldPoint()
    }
  } finally {
    applyRecognized(sourceId)
    emit('recognition:source', { sourceId })
  }
  const result = report()
  if (result.failed && !result.done)
    throw new PermanentJobError(
      getSettings().language.startsWith('zh')
        ? `识别失败（${result.failed} 页），可手动重试`
        : `Recognition failed for ${result.failed} page(s); retry manually`
    )
  return result
}

/** 删除本地识别模型（释放空间） */
export function removeRecognizer(): void {
  stopRecognizer()
  for (const m of Object.values(LOCAL_MODELS)) for (const f of [m.model, m.mmproj]) rmSync(filePath(f), { force: true })
  for (const f of LEGACY_FILES) rmSync(join(dir(), f), { force: true })
  setStatus({ state: 'missing', progress: 0 })
}

const GroundBlocksSchema = z.array(
  z.object({
    label: z.string().max(80),
    text: z.string().max(100000),
    box: z.tuple([z.number().min(0).max(1000), z.number().min(0).max(1000), z.number().min(0).max(1000), z.number().min(0).max(1000)])
  })
)
/** 只读投影 OCR 缓存，旧版/损坏的坐标不交给文字层。 */
export function scanPageTexts(sourceId: string): ScanPageText[] {
  const source = getDb().select().from(sources).where(eq(sources.id, sourceId)).get()
  if (!source || source.deletedAt) return []
  return getDb()
    .select()
    .from(sourcePages)
    .where(and(eq(sourcePages.sourceId, sourceId), eq(sourcePages.need, 'scan'), eq(sourcePages.status, 'done')))
    .all()
    .flatMap((r) => {
      try {
        const result = GroundBlocksSchema.safeParse(JSON.parse(r.blocks ?? '[]'))
        return result.success ? [{ page: r.page, blocks: result.data }] : []
      } catch {
        return []
      }
    })
}

/** 仍在识别（排队或进行中）的资料：回答用到它们时要如实说明可能缺少表格、图片与扫描页（v0.7.6） */
export function recognizingSources(ids: Iterable<string>): { id: string; title: string; progress: number }[] {
  const list = [...new Set(ids)]
  if (!list.length) return []
  const rows = getDb()
    .select({ key: jobs.dedupeKey, progress: jobs.progress })
    .from(jobs)
    .where(
      and(
        inArray(
          jobs.dedupeKey,
          list.map((id) => `recognize:${id}`)
        ),
        inArray(jobs.status, ['queued', 'running'])
      )
    )
    .all()
  return rows.map((r) => {
    const id = r.key!.slice('recognize:'.length)
    const title = getDb().select({ title: sources.title }).from(sources).where(eq(sources.id, id)).get()?.title ?? id
    return { id, title, progress: r.progress }
  })
}
