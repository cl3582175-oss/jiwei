import { chmod, mkdir, rm, stat } from 'fs/promises'
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
import { replaceSegments } from './segments'
import { requestIndex } from './ai/indexer'
import { cuesToSegments, parseSubtitles, type Cue } from '../lib/subtitles'
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
  return [join(p.runtime, 'node_modules/sherpa-onnx-node/package.json'), p.ffmpeg, p.vad, p.model, p.tokens].every((f) => existsSync(f))
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
      const rt = runtimeDir()
      if (!existsSync(join(rt, 'node_modules/sherpa-onnx-node/package.json'))) {
        const jsTgz = join(tmp, `sherpa-onnx-node-${SHERPA}.tgz`)
        const nativeTgz = join(tmp, `${pkg.name}-${SHERPA}.tgz`)
        await download(
          { name: 'sherpa-onnx-node', ...SHERPA_JS, urls: NPM('sherpa-onnx-node', `sherpa-onnx-node-${SHERPA}.tgz`), dest: jsTgz },
          report('js')
        )
        await download(
          { name: pkg.name, size: pkg.size, sha256: pkg.sha256, urls: NPM(pkg.name, `${pkg.name}-${SHERPA}.tgz`), dest: nativeTgz },
          report('native')
        )
        await rm(rt, { recursive: true, force: true })
        for (const [tgz, name] of [
          [nativeTgz, pkg.name],
          [jsTgz, 'sherpa-onnx-node']
        ]) {
          const dir = join(rt, 'node_modules', name)
          await mkdir(dir, { recursive: true })
          await untar({ file: tgz, cwd: dir, strip: 1 })
        }
        await rm(jsTgz, { force: true })
        await rm(nativeTgz, { force: true })
      } else {
        done.set('js', SHERPA_JS.size)
        done.set('native', pkg.size)
      }

      if (!existsSync(ffmpegPath())) {
        const tgz = join(tmp, ff.file)
        await download({ name: 'ffmpeg', size: ff.size, sha256: ff.sha256, urls: NPM(ff.pkg, ff.file), dest: tgz }, report('ffmpeg'))
        await mkdir(ffmpegDir(), { recursive: true })
        await untar({ file: tgz, cwd: ffmpegDir(), strip: 1 })
        if (process.platform !== 'win32') await chmod(ffmpegPath(), 0o755)
        await rm(tgz, { force: true })
      } else done.set('ffmpeg', ff.size)

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
  const n = replaceSegments(sourceId, cuesToSegments(cues))
  requestIndex()
  return n
}

export function applySubtitleFile(sourceId: string, path: string): number {
  return applySubtitles(sourceId, readFileSync(path, 'utf8'))
}

export function enqueueTranscribe(sourceId: string): void {
  enqueue('source.transcribe', { sourceId }, { dedupeKey: `transcribe:${sourceId}` })
}

const sourceTitle = (id: string): string =>
  getDb().select({ title: sources.title }).from(sources).where(eq(sources.id, id)).get()?.title ?? id

export function registerAsrJob(): void {
  registerJobKind<{ sourceId: string }>('source.transcribe', {
    title: ({ sourceId }) => `转写：${sourceTitle(sourceId)}`,
    async run({ sourceId }, ctx) {
      const row = getDb()
        .select({ a: assets })
        .from(sources)
        .leftJoin(assets, eq(sources.assetId, assets.id))
        .where(eq(sources.id, sourceId))
        .get()
      if (!row?.a) return { skipped: 'no file' }
      if (!installed()) await installAsr()
      const file = assetPath(row.a.id, row.a.ext)
      await stat(file)
      const cues = await ctx.worker<Cue[]>('transcribe', { file, ...asrPaths() })
      if (ctx.isCanceled()) return
      if (!cues.length) return { segments: 0, note: 'no speech' }
      const n = replaceSegments(sourceId, cuesToSegments(cues))
      requestIndex()
      return { segments: n, cues: cues.length }
    }
  })
}
