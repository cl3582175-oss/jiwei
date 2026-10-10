import { recordingAudio } from './recording'
import { enqueueMoss, mossStatus } from './moss'
import { mossTranscriptRevision } from '../lib/moss'
import { voiceText } from './voiceMessages'
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from 'fs/promises'
import { execFile } from 'child_process'
import { tmpdir } from 'os'
import { net } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import log from 'electron-log/main'
import { x as untar } from 'tar'
import { getDb } from '../db'
import { assets, sources } from '../db/schema'
import { download } from './download'
import { modelsDir } from './ai/localEmbedding'
import { assetPath } from './assets'
import { emit } from '../events'
import { enqueue, registerJobKind } from './jobs'
import { listSegments, replaceSegments } from './segments'
import { requestIndex } from './ai/indexer'
import { cuesToSegments, parseSubtitles, type Cue } from '../lib/subtitles'
import { decryptKey, getProviderRow } from './ai/providers'
import { getSettings } from './settings'
import type { AsrStatus } from '@shared/types'

// 语音转写（视频 / 音频的“文字层”）：
//   - 引擎：sherpa-onnx（N-API 原生模块，Electron / Node 通用）+ ffmpeg（解码音轨），按需从 npm 镜像下载
//   - 模型：Silero VAD（切句）+ SenseVoice-Small int8（中英日韩粤，带标点），从 ModelScope 下载
//   - 全部放在所有知识库共享的模型目录，sha256 校验
//   - 转写在后台工作进程中进行；结果按停顿合并为带时间段的片段，进入知识库索引
// 资料附带字幕（同名 .srt / .vtt）时直接使用字幕，不做识别。

const SHERPA = '1.13.8'
const NPM = (pkg: string, file: string): string[] => [
  `https://registry.npmmirror.com/${pkg}/-/${file}`,
  `https://registry.npmjs.org/${pkg}/-/${file}`
]

const PLATFORM = `${process.platform}-${process.arch}`
const SHERPA_PKG: Record<string, { name: string; size: number; sha256: string }> = {
  'darwin-arm64': {
    name: 'sherpa-onnx-darwin-arm64',
    size: 10047754,
    sha256: 'e1abc1d9676478996574de922e55714d80b4500b860bc4e7349aa01cd0ea4929'
  },
  'darwin-x64': {
    name: 'sherpa-onnx-darwin-x64',
    size: 11191481,
    sha256: '3e583d3423160cb8a0f9316008e293ad9a6b66c63e1966ad399a88300390fbaa'
  },
  'win32-x64': { name: 'sherpa-onnx-win-x64', size: 8894875, sha256: 'fe522f02a5c113c2567a43982107ef41ae517f9a431931e90731e7e4d4341073' },
  'linux-x64': { name: 'sherpa-onnx-linux-x64', size: 11089653, sha256: '13291bcd825da5858ca27a35443e9a2c229a40616c0910086de2db12c5c9312c' }
}
const SHERPA_JS = { size: 11954, sha256: 'db2a7b8b18d950b6e9ca5c1c919afec33fd3dd2bfef1aade0bea5a9fe7a1f0f1' }
const FFMPEG: Record<string, { pkg: string; file: string; size: number; sha256: string }> = {
  'darwin-arm64': {
    pkg: '@ffmpeg-installer/darwin-arm64',
    file: 'darwin-arm64-4.1.5.tgz',
    size: 15712439,
    sha256: '8a4306e64ed3ba3cb5e51093266c8c72f65314bec146c899a50426f21aaa0f44'
  },
  'darwin-x64': {
    pkg: '@ffmpeg-installer/darwin-x64',
    file: 'darwin-x64-4.1.0.tgz',
    size: 22361696,
    sha256: '4f22b9ce0c0507e3f4cd6e822fb23214abc5fb70d48eb046ff94a1484299cdbf'
  },
  'win32-x64': {
    pkg: '@ffmpeg-installer/win32-x64',
    file: 'win32-x64-4.1.0.tgz',
    size: 22202240,
    sha256: '2aa313be3585994d710197bc4196f5fcbb6a1469be1013b24d200e45d773592f'
  },
  'linux-x64': {
    pkg: '@ffmpeg-installer/linux-x64',
    file: 'linux-x64-4.1.0.tgz',
    size: 23070854,
    sha256: 'b836abe532912ae6c3388dbe713952af293a3d005fc9e4d34d52f14da99dda71'
  }
}
const MS = 'https://www.modelscope.cn/models'
const MODELS = {
  vad: {
    file: 'silero_vad.onnx',
    size: 2327524,
    sha256: '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f',
    urls: [`${MS}/pengzhendong/silero-vad/resolve/master/silero_vad.onnx`]
  },
  tokens: {
    file: 'sense-voice-2024-07-17/tokens.txt',
    size: 315894,
    sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    urls: [
      `${MS}/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master/tokens.txt`,
      'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt'
    ]
  },
  model: {
    file: 'sense-voice-2024-07-17/model.int8.onnx',
    size: 239233841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    urls: [
      `${MS}/pengzhendong/sherpa-onnx-sense-voice-zh-en-ja-ko-yue/resolve/master/model.int8.onnx`,
      'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx'
    ]
  }
}

const asrDir = (): string => join(modelsDir(), 'asr')
const runtimeDir = (): string => join(modelsDir(), `sherpa-onnx-${SHERPA}`)
const ffmpegDir = (): string => join(modelsDir(), 'ffmpeg')
export const ffmpegPath = (): string => join(ffmpegDir(), process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')

export interface AsrPaths {
  runtime: string
  ffmpeg: string
  vad: string
  model: string
  tokens: string
}
export const asrPaths = (): AsrPaths => ({
  runtime: runtimeDir(),
  ffmpeg: ffmpegPath(),
  vad: join(asrDir(), MODELS.vad.file),
  model: join(asrDir(), MODELS.model.file),
  tokens: join(asrDir(), MODELS.tokens.file)
})

const installed = (): boolean => {
  const p = asrPaths()
  return sherpaRuntimeReady() && [p.ffmpeg, p.vad, p.model, p.tokens].every((f) => existsSync(f))
}
export const sherpaRuntimeReady = (): boolean => {
  const pkg = SHERPA_PKG[PLATFORM]
  return !!pkg && ['sherpa-onnx-node', pkg.name].every((name) => existsSync(join(runtimeDir(), 'node_modules', name, 'package.json')))
}

let status: AsrStatus = { state: 'missing', progress: 0, mirror: null, speed: null, message: null }
const setStatus = (patch: Partial<AsrStatus>): void => {
  status = { ...status, ...patch }
  emit('asr:status', status)
}

export function asrStatus(): AsrStatus {
  if (status.state !== 'downloading' && status.state !== 'error') status = { ...status, state: installed() ? 'ready' : 'missing' }
  return status
}

export const asrSupported = (): boolean => PLATFORM in SHERPA_PKG && PLATFORM in FFMPEG

let installing: Promise<void> | null = null

/** 下载并安装转写引擎与模型（可重复调用：已完成的部分会跳过） */
export function installAsr(): Promise<void> {
  if (installing) return installing
  installing = (async () => {
    if (!asrSupported()) throw new Error(`暂不支持此平台：${PLATFORM}`)
    const pkg = SHERPA_PKG[PLATFORM]
    const ff = FFMPEG[PLATFORM]
    // 各部分按大小计入总进度
    const parts = [
      { key: 'js', size: SHERPA_JS.size },
      { key: 'native', size: pkg.size },
      { key: 'ffmpeg', size: ff.size },
      { key: 'vad', size: MODELS.vad.size },
      { key: 'tokens', size: MODELS.tokens.size },
      { key: 'model', size: MODELS.model.size }
    ]
    const total = parts.reduce((n, p) => n + p.size, 0)
    const done = new Map<string, number>()
    const report = (key: string) => (p: { received: number; speed: number; mirror: string }) => {
      done.set(key, p.received)
      const sum = [...done.values()].reduce((a, b) => a + b, 0)
      setStatus({ state: 'downloading', progress: Math.min(0.999, sum / total), mirror: p.mirror, speed: p.speed, message: null })
    }
    try {
      setStatus({ state: 'downloading', progress: 0, message: null })
      await mkdir(asrDir(), { recursive: true })
      const tmp = join(modelsDir(), 'tmp')
      await mkdir(tmp, { recursive: true })

      // 引擎：sherpa-onnx-node（JS）+ 平台原生包，按 node_modules 结构解压，供 require 解析
      await ensureSherpaRuntime()
      done.set('js', SHERPA_JS.size)
      done.set('native', pkg.size)

      if (!existsSync(ffmpegPath())) await ensureFfmpeg(report('ffmpeg'))
      else done.set('ffmpeg', ff.size)

      for (const key of ['vad', 'tokens', 'model'] as const) {
        const m = MODELS[key]
        const dest = join(asrDir(), m.file)
        await mkdir(join(dest, '..'), { recursive: true })
        await download({ name: m.file, size: m.size, sha256: m.sha256, urls: m.urls, dest }, report(key))
        done.set(key, m.size)
      }
      setStatus({ state: 'ready', progress: 1, mirror: null, speed: null, message: null })
      log.info('[asr] installed')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error('[asr] install failed', msg)
      setStatus({ state: 'error', message: msg })
      throw e
    } finally {
      installing = null
    }
  })()
  return installing
}

let runtimeInstall: Promise<void> | null = null
/** CAM++ 与 SenseVoice 共用固定版本运行时，单独安装声纹不下载识别模型。 */
export function ensureSherpaRuntime(): Promise<void> {
  if (runtimeInstall) return runtimeInstall
  runtimeInstall = (async () => {
    const pkg = SHERPA_PKG[PLATFORM],
      rt = runtimeDir()
    if (!pkg) throw new Error(`暂不支持此平台：${PLATFORM}`)
    if (sherpaRuntimeReady()) return
    await mkdir(modelsDir(), { recursive: true })
    // 同一文件系统中暂存完整运行时，下载/解包失败不能留下假 ready 的 JS 半成品。
    const tmp = await mkdtemp(join(modelsDir(), '.jiwei-sherpa-'))
    const stage = join(tmp, 'runtime')
    try {
      for (const [name, meta] of [
        ['sherpa-onnx-node', SHERPA_JS],
        [pkg.name, pkg]
      ] as const) {
        const tgz = join(tmp, `${name}.tgz`)
        await download({ name, size: meta.size, sha256: meta.sha256, urls: NPM(name, `${name}-${SHERPA}.tgz`), dest: tgz }, () => {})
        const dir = join(stage, 'node_modules', name)
        await mkdir(dir, { recursive: true })
        await untar({ file: tgz, cwd: dir, strip: 1 })
      }
      await rm(rt, { recursive: true, force: true })
      await rename(stage, rt)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })().finally(() => {
    runtimeInstall = null
  })
  return runtimeInstall
}

/** 只安装 ffmpeg（云端转写只需要它来切分音频） */
export async function ensureFfmpeg(onProgress?: (p: { received: number; speed: number; mirror: string }) => void): Promise<void> {
  if (existsSync(ffmpegPath())) return
  const ff = FFMPEG[PLATFORM]
  if (!ff) throw new Error(`暂不支持此平台：${PLATFORM}`)
  const tmp = join(modelsDir(), 'tmp')
  await mkdir(tmp, { recursive: true })
  const tgz = join(tmp, ff.file)
  await download({ name: 'ffmpeg', size: ff.size, sha256: ff.sha256, urls: NPM(ff.pkg, ff.file), dest: tgz }, onProgress ?? (() => {}))
  await mkdir(ffmpegDir(), { recursive: true })
  await untar({ file: tgz, cwd: ffmpegDir(), strip: 1 })
  if (process.platform !== 'win32') await chmod(ffmpegPath(), 0o755)
  await rm(tgz, { force: true })
}

/* ——— 云端转写（OpenAI 兼容 /audio/transcriptions） ——— */

const CHUNK_SEC = 600

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024 })
    let err = ''
    p.stderr!.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 失败（${code}）：${err.split('\n').slice(-3).join(' ')}`))))
  })
}

/**
 * 云端转写：ffmpeg 切成 10 分钟的低码率单声道片段（远小于接口的 25 MB 限制），逐段上传，
 * 取 verbose_json 的分句时间，按片段偏移拼回完整时间轴。音频会上传到所选服务商。
 */
export async function transcribeCloud(
  file: string,
  providerId: string,
  model: string,
  progress: (p: number) => void,
  allowed: () => boolean = () => true
): Promise<Cue[]> {
  const row = getProviderRow(providerId)
  const key = decryptKey(row)
  const base = row.baseUrl.replace(/\/+$/, '')
  await ensureFfmpeg()
  const dir = await mkdtemp(join(tmpdir(), 'jiwei-asr-'))
  try {
    await run(ffmpegPath(), [
      '-hide_banner',
      '-nostdin',
      '-i',
      file,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-b:a',
      '32k',
      '-f',
      'segment',
      '-segment_time',
      String(CHUNK_SEC),
      '-reset_timestamps',
      '1',
      join(dir, 'part%03d.mp3')
    ])
    const parts = (await readdir(dir)).filter((n) => n.endsWith('.mp3')).sort()
    const cues: Cue[] = []
    for (const [i, name] of parts.entries()) {
      const form = new FormData()
      form.append('file', new Blob([await readFile(join(dir, name))], { type: 'audio/mpeg' }), name)
      form.append('model', model)
      form.append('response_format', 'verbose_json')
      form.append('timestamp_granularities[]', 'segment')
      if (!allowed()) throw new Error(voiceText('privacyChanged'))
      const res = await net.fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        body: form
      })
      if (!res.ok) throw new Error(`云端转写失败：HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
      const json = (await res.json()) as { text?: string; duration?: number; segments?: { start: number; end: number; text: string }[] }
      const off = i * CHUNK_SEC
      if (json.segments?.length)
        for (const sg of json.segments) {
          const text = sg.text.trim()
          if (text) cues.push({ start: off + sg.start, end: off + sg.end, text })
        }
      else if (json.text?.trim()) cues.push({ start: off, end: off + (json.duration ?? CHUNK_SEC), text: json.text.trim() })
      progress((i + 1) / parts.length)
    }
    return cues
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 当前设置下能否自动转写（本地引擎已安装，或已配置云端转写） */
export function canAutoTranscribe(): boolean {
  const t = getSettings().ai.transcription
  if (t?.mode === 'cloud') return !!t.providerId && !!t.model
  return asrStatus().state === 'ready'
}

/* ——— 字幕与转写任务 ——— */

const MEDIA_EXTS = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'opus'])
export const isMedia = (ext: string): boolean => MEDIA_EXTS.has(ext.toLowerCase())

/** 导入媒体时：同目录同名字幕优先 */
export function findSidecarSubtitles(mediaPath: string): string | null {
  const base = mediaPath.replace(/\.[^.]+$/, '')
  for (const ext of ['.srt', '.vtt', '.zh.srt', '.zh-CN.srt', '.zh.vtt', '.en.srt', '.en.vtt'])
    if (existsSync(base + ext)) return base + ext
  return null
}

/** 用字幕作为资料的转写稿 */
export function applySubtitles(sourceId: string, text: string): number {
  const cues = parseSubtitles(text)
  if (!cues.length) throw new Error('字幕文件中没有可用的内容')
  const n = replaceSegments(sourceId, [...listSegments(sourceId).filter((s) => s.kind !== 'transcript'), ...cuesToSegments(cues)])
  requestIndex()
  return n
}

export function applySubtitleFile(sourceId: string, path: string): number {
  return applySubtitles(sourceId, readFileSync(path, 'utf8'))
}

export function enqueueTranscribe(sourceId: string, overwrite = false): void {
  if (!overwrite && listSegments(sourceId).some((s) => s.kind === 'transcript' && s.locator.edited))
    throw new Error(voiceText('overwriteConfirm'))
  if (mossStatus().state === 'ready') return enqueueMoss(sourceId, overwrite)
  enqueue(
    'source.transcribe',
    { sourceId, transcriptRevision: mossTranscriptRevision(listSegments(sourceId)) },
    { dedupeKey: `transcribe:${sourceId}` }
  )
}

const sourceTitle = (id: string): string =>
  getDb().select({ title: sources.title }).from(sources).where(eq(sources.id, id)).get()?.title ?? id

export function registerAsrJob(): void {
  registerJobKind<{ sourceId: string; transcriptRevision?: string }>('source.transcribe', {
    title: ({ sourceId }) => `转写：${sourceTitle(sourceId)}`,
    async run({ sourceId, transcriptRevision }, ctx) {
      const row = getDb()
        .select({ a: assets, s: sources })
        .from(sources)
        .leftJoin(assets, eq(sources.assetId, assets.id))
        .where(eq(sources.id, sourceId))
        .get()
      if (!row || row.s.deletedAt) return { skipped: 'no source' }
      const db = getDb(),
        revision = transcriptRevision ?? mossTranscriptRevision(listSegments(sourceId))
      if (mossTranscriptRevision(listSegments(sourceId)) !== revision) throw new Error(voiceText('transcriptChanged'))
      const file = row.s.kind === 'recording' ? recordingAudio(sourceId) : row.a ? assetPath(row.a.id, row.a.ext) : null
      if (!file) throw new Error(voiceText('missingAudio'))
      await stat(file)
      const t = getSettings().ai.transcription
      let cues: Cue[]
      if (!row.s.aiExcluded && t?.mode === 'cloud' && t.providerId && t.model)
        cues = await transcribeCloud(
          file,
          t.providerId,
          t.model,
          (p) => ctx.progress(p),
          () => {
            const current = getDb().select().from(sources).where(eq(sources.id, sourceId)).get()
            return getDb() === db && !ctx.isCanceled() && !!current && !current.deletedAt && !current.aiExcluded
          }
        )
      else {
        if (!installed()) await installAsr()
        cues = await ctx.worker<Cue[]>('transcribe', { file, ...asrPaths() })
      }
      if (ctx.isCanceled()) return
      if (getDb() !== db || mossTranscriptRevision(listSegments(sourceId)) !== revision) throw new Error(voiceText('transcriptChanged'))
      if (!cues.length) return { segments: 0, note: 'no speech' }
      const n = replaceSegments(sourceId, [...listSegments(sourceId).filter((s) => s.kind !== 'transcript'), ...cuesToSegments(cues)])
      requestIndex()
      return { segments: n, cues: cues.length }
    }
  })
}
