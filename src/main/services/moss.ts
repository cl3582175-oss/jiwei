import { app } from 'electron'
import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { and, eq, inArray } from 'drizzle-orm'
import { x as untar } from 'tar'
import JSZip from 'jszip'
import log from 'electron-log/main'
import { getDb } from '../db'
import { jobs, sources, assets } from '../db/schema'
import { assetPath } from './assets'
import { dataDir } from '../db'
import { storedRecordingFile } from './recordingFiles'
import { recordingAudio, recordingForSource, withRecordingFile } from './recording'
import { extractRecordingVoiceprints, voiceprintStatus } from './voiceprint'
import { alignSpeakers, reviewSpeakers, type VoiceCue } from '../lib/voiceprint'
import { identifySpeakers, saveRecordingSpeakers, listPeople, listCorrections, voiceprintEpoch } from './people'
import { voiceText, voiceErrorText } from './voiceMessages'
import { emit } from '../events'
import {
  buildMossHotwords,
  mapMossToVideo,
  mergeMossChunks,
  mergeMossSegments,
  mossTranscriptRevision,
  parseMossOutput,
  parseMossRecording,
  planMossChunks,
  type MossChunk,
  type MossCue,
  type MossRecording
} from '../lib/moss'
import { modelsDir } from './ai/localEmbedding'
import { requestIndex } from './ai/indexer'
import { ensureFfmpeg, ffmpegPath } from './asr'
import { download, sha256File } from './download'
import { cancelJob, enqueue, registerJobKind, type JobContext } from './jobs'
import { listConcepts } from './learner'
import { listSegments, replaceSegments } from './segments'
import type { MossStatus } from '@shared/moss'

export type { MossStatus } from '@shared/moss'

// 精修使用独立 CLI 子进程：一次录音处理完就释放模型，不保留常驻服务。
const VERSION = '0.8.42'
const PLATFORM = `${process.platform}-${process.arch}`
const GH = `https://github.com/CrispStrobe/CrispASR/releases/download/v${VERSION}`
const RUNTIMES: Record<string, { file: string; folder: string; size: number; sha256: string }> = {
  'darwin-arm64': {
    file: 'crispasr-macos-arm64.tar.gz',
    folder: 'crispasr-macos-arm64',
    size: 18008551,
    sha256: '87899a6a32af2055da5267bb366b51be9c5478bbf9dd0195334f4af6f0cbb773'
  },
  // 两个平台的大小与哈希均来自实际下载的 v0.8.42 发布包，并与 GitHub digest 交叉核对。
  'darwin-x64': {
    file: 'crispasr-macos-x86_64.tar.gz',
    folder: 'crispasr-macos-x86_64',
    size: 18497013,
    sha256: 'cdbcdc60af6c5579965bdf6463eb6789f1b008e5ab8c83b878b696920e33ee1d'
  },
  'win32-x64': {
    file: 'crispasr-windows-x86_64-cpu.zip',
    folder: 'crispasr-windows-x86_64-cpu',
    size: 9083292,
    sha256: 'b8d9102f695238c04d5c676098c8af60d40010396ff25ac5f9aadcc3d00ea7c5'
  }
}
const MODEL = {
  file: 'moss-transcribe-diarize-0.9b-q4_k.gguf',
  size: 1190110816,
  sha256: '1801a463daffd3c4f40d7178c75425fc75260362b6f2653815f0a16a508c932e'
}
const REPO = 'mysteriov/MOSS-Transcribe-Diarize-GGUF'
const JOB_KIND = 'source.moss'
const dir = (): string => join(modelsDir(), 'moss')
const runtimeDir = (): string => join(dir(), `crispasr-${VERSION}`)
const modelPath = (): string => join(dir(), MODEL.file)
const binaryPath = (root = runtimeDir()): string =>
  join(root, RUNTIMES[PLATFORM]?.folder ?? '', process.platform === 'win32' ? 'crispasr.exe' : 'crispasr')
const supported = (): boolean => PLATFORM in RUNTIMES

interface RuntimeReceipt {
  archiveSha256: string
  files: { path: string; size: number; sha256: string }[]
}

/** 解压包来自已校验的固定版本；记录各文件哈希以便在执行前再次发现损坏。 */
function runtimeReceipt(): RuntimeReceipt | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(runtimeDir(), 'verified.json'), 'utf8'))
    if (typeof value !== 'object' || value === null) return null
    const receipt = value as RuntimeReceipt
    if (receipt.archiveSha256 !== RUNTIMES[PLATFORM]?.sha256 || !Array.isArray(receipt.files) || !receipt.files.length) return null
    for (const file of receipt.files) {
      if (
        typeof file?.path !== 'string' ||
        isAbsolute(file.path) ||
        file.path.split(/[\\/]/).includes('..') ||
        !Number.isSafeInteger(file.size) ||
        typeof file.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        statSync(join(runtimeDir(), file.path)).size !== file.size
      )
        return null
    }
    return existsSync(binaryPath()) ? receipt : null
  } catch {
    return null
  }
}

const modelExists = (): boolean => {
  try {
    return statSync(modelPath()).size === MODEL.size
  } catch {
    return false
  }
}

let status: MossStatus = {
  state: supported() ? 'missing' : 'unsupported',
  progress: 0,
  mirror: null,
  speed: null,
  message: null,
  size: 0,
  running: false,
  supported: supported()
}

const setStatus = (patch: Partial<MossStatus>): void => {
  status = { ...status, ...patch }
  emit('moss:status', mossStatus())
}

export function mossStatus(): MossStatus {
  const runtime = runtimeReceipt()
  const model = modelExists()
  if (!supported()) status = { ...status, state: 'unsupported', message: `暂不支持此平台：${PLATFORM}` }
  else if (status.state !== 'downloading' && status.state !== 'error') status = { ...status, state: runtime && model ? 'ready' : 'missing' }
  return {
    ...status,
    size: supported() ? (runtime ? 0 : RUNTIMES[PLATFORM].size) + (model ? 0 : MODEL.size) : 0,
    supported: supported()
  }
}

let installing: Promise<void> | null = null
let installAbort: AbortController | null = null
let removing = false
let serial: Promise<void> = Promise.resolve()
const active = new Set<AbortController>()

function command(file: string, args: string[], signal: AbortSignal, cwd = dirname(file)): Promise<string> {
  if (signal.aborted) return Promise.reject(new Error('精修已取消'))
  return new Promise((resolveCommand, reject) => {
    const child = execFile(file, args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 })
    let stderr = ''
    let stdout = ''
    let killTimer: NodeJS.Timeout | undefined
    child.stderr!.on('data', (data: Buffer) => (stderr = (stderr + data.toString()).slice(-4000)))
    child.stdout!.on('data', (data: Buffer) => (stdout = (stdout + data.toString()).slice(-8000)))
    const abort = (): void => {
      child.kill()
      // 原生进程若没有响应终止信号，仍要确保取消后不再持续占用模型内存。
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
      killTimer.unref()
    }
    const cleanup = (): void => {
      signal.removeEventListener('abort', abort)
      if (killTimer) clearTimeout(killTimer)
    }
    signal.addEventListener('abort', abort, { once: true })
    child.on('error', (error) => {
      cleanup()
      reject(error)
    })
    child.on('close', (code) => {
      cleanup()
      if (signal.aborted) reject(new Error('精修已取消或超时，原文字稿已保留'))
      else if (code !== 0) reject(new Error(`精修进程失败（${code}）：${stderr.trim().slice(-1500)}`))
      else resolveCommand(stdout)
    })
    if (signal.aborted) abort()
  })
}

async function runtimeFiles(root: string, at = root): Promise<RuntimeReceipt['files']> {
  const files: RuntimeReceipt['files'] = []
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const path = join(at, entry.name)
    if (entry.isDirectory()) files.push(...(await runtimeFiles(root, path)))
    else if (entry.isFile()) files.push({ path: relative(root, path), size: (await stat(path)).size, sha256: await sha256File(path) })
    else throw new Error('精修运行时包含不支持的链接文件')
  }
  return files
}

async function verifyRuntime(): Promise<boolean> {
  const receipt = runtimeReceipt()
  if (!receipt) return false
  for (const file of receipt.files) if ((await sha256File(join(runtimeDir(), file.path))) !== file.sha256) return false
  return true
}

async function installRuntime(signal: AbortSignal, progress: (received: number, speed: number, mirror: string) => void): Promise<void> {
  const runtime = RUNTIMES[PLATFORM]
  const archive = join(dir(), runtime.file)
  await download(
    {
      ...runtime,
      name: `CrispASR ${VERSION}`,
      dest: archive,
      urls: [`https://gh-proxy.com/${GH}/${runtime.file}`, `https://ghfast.top/${GH}/${runtime.file}`, `${GH}/${runtime.file}`]
    },
    (p) => progress(p.received, p.speed, p.mirror),
    signal
  )
  const stage = await mkdtemp(join(dir(), 'runtime-install-'))
  try {
    if (runtime.file.endsWith('.zip')) {
      const zip = await JSZip.loadAsync(await readFile(archive))
      for (const [name, entry] of Object.entries(zip.files)) {
        const path = resolve(stage, name)
        const rel = relative(stage, path)
        if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error('精修运行时压缩包路径无效')
        if (entry.dir) continue
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, await entry.async('nodebuffer'))
      }
    } else await untar({ file: archive, cwd: stage, strict: true })
    if (!existsSync(binaryPath(stage))) throw new Error('精修运行时解压后缺少 crispasr')
    if (process.platform === 'darwin') {
      await command('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', stage], signal)
      await chmod(binaryPath(stage), 0o755)
    }
    const receipt: RuntimeReceipt = { archiveSha256: runtime.sha256, files: await runtimeFiles(stage) }
    await writeFile(join(stage, 'verified.json'), JSON.stringify(receipt))
    if (signal.aborted) throw new Error('已取消下载')
    await rm(runtimeDir(), { recursive: true, force: true })
    await rename(stage, runtimeDir())
    await rm(archive, { force: true })
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

export function installMoss(): Promise<void> {
  if (installing) return installing
  if (removing || active.size) return Promise.reject(new Error('精修正在运行或删除，请稍后再安装'))
  if (!supported()) return Promise.reject(new Error(`暂不支持此平台：${PLATFORM}`))
  const abort = new AbortController()
  installAbort = abort
  installing = (async () => {
    const runtime = RUNTIMES[PLATFORM]
    const total = runtime.size + MODEL.size
    const done = { runtime: 0, model: 0 }
    const progress = (key: keyof typeof done) => (received: number, speed: number, mirror: string) => {
      done[key] = received
      setStatus({ state: 'downloading', progress: Math.min(0.99, (done.runtime + done.model) / total), mirror, speed })
    }
    try {
      setStatus({ state: 'downloading', progress: 0, message: null })
      await mkdir(dir(), { recursive: true })
      if (!(await verifyRuntime())) await installRuntime(abort.signal, progress('runtime'))
      done.runtime = runtime.size
      await download(
        {
          ...MODEL,
          name: 'MOSS 精修模型',
          dest: modelPath(),
          urls: [
            `https://www.modelscope.cn/models/${REPO}/resolve/master/${MODEL.file}`,
            `https://hf-mirror.com/${REPO}/resolve/main/${MODEL.file}`,
            `https://huggingface.co/${REPO}/resolve/main/${MODEL.file}`
          ]
        },
        (p) => progress('model')(p.received, p.speed, p.mirror),
        abort.signal
      )
      if (abort.signal.aborted) throw new Error('已取消下载')
      await ensureFfmpeg()
      if (abort.signal.aborted) throw new Error('已取消下载')
      setStatus({ state: 'ready', progress: 1, mirror: null, speed: null, message: null })
    } catch (error) {
      setStatus({ state: 'error', speed: null, message: error instanceof Error ? error.message : String(error) })
      throw error
    }
  })().finally(() => {
    installing = null
    installAbort = null
  })
  return installing
}

/** 退出时只终止进程，任务队列会在下次启动时按原有机制恢复。 */
export function stopMoss(): void {
  installAbort?.abort()
  for (const abort of active) abort.abort()
}

export async function removeMoss(): Promise<void> {
  if (removing) return
  removing = true
  try {
    for (const row of getDb()
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.kind, JOB_KIND), inArray(jobs.status, ['queued', 'running'])))
      .all())
      cancelJob(row.id)
    stopMoss()
    await installing?.catch(() => {})
    await serial.catch(() => {})
    await rm(dir(), { recursive: true, force: true })
    setStatus({ state: 'missing', progress: 0, speed: null, mirror: null, message: null, running: false })
  } finally {
    removing = false
  }
}

interface RecordingSnapshot {
  recording: MossRecording | null
  hash: string
  file: string
  size: number
  mtime: number
}

interface MossJobPayload {
  sourceId: string
  recordingHash: string
  audioSize: number
  audioMtime: number
  transcriptHash: string
  voiceEpoch: string
}

function readRecording(sourceId: string): RecordingSnapshot {
  if (!/^[\w-]{1,128}$/.test(sourceId)) throw new Error('资料 ID 无效')
  const source = getDb().select().from(sources).where(eq(sources.id, sourceId)).get()
  if (source && ['recording', 'audio', 'video'].includes(source.kind)) {
    const asset = source.assetId ? getDb().select().from(assets).where(eq(assets.id, source.assetId)).get() : null
    const file = source.kind === 'recording' ? recordingAudio(sourceId) : asset ? assetPath(asset.id, asset.ext) : null
    if (!file) throw new Error(voiceText('missingAudio'))
    const info = statSync(file)
    if (!info.isFile() || !info.size) throw new Error(voiceText('emptyAudio'))
    return {
      recording: null,
      hash: createHash('sha256').update(`${sourceId}:${info.size}:${info.mtimeMs}`).digest('hex'),
      file,
      size: info.size,
      mtime: info.mtimeMs
    }
  }
  const root = join(app.getPath('userData'), 'course-audio')
  const manifestPath = join(root, `${sourceId}.json`)
  const file = join(root, `${sourceId}.webm`)
  if (!existsSync(manifestPath) || !existsSync(file)) throw new Error('尚无完整录音，请先从开头录制课程')
  if (statSync(manifestPath).size > 16 * 1024 * 1024) throw new Error('录音清单过大')
  const raw = readFileSync(manifestPath, 'utf8')
  const recording = parseMossRecording(JSON.parse(raw))
  const info = statSync(file)
  if (!info.isFile() || info.size === 0) throw new Error('课程录音为空，请重新录制')
  return { recording, hash: createHash('sha256').update(raw).digest('hex'), file, size: info.size, mtime: info.mtimeMs }
}

function sameRecording(snapshot: RecordingSnapshot, payload: MossJobPayload): boolean {
  return snapshot.hash === payload.recordingHash && snapshot.size === payload.audioSize && snapshot.mtime === payload.audioMtime
}

export function enqueueMoss(sourceId: string, overwrite = false): void {
  const source = getDb().select().from(sources).where(eq(sources.id, sourceId)).get()
  if (!source || source.deletedAt || !['web', 'recording', 'audio', 'video'].includes(source.kind))
    throw new Error(voiceText('missingAvSource'))
  if (!overwrite && listSegments(sourceId).some((s) => s.kind === 'transcript' && s.locator.edited))
    throw new Error(voiceText('overwriteConfirm'))
  if (removing || mossStatus().state !== 'ready') throw new Error('请先在设置中安装精修引擎')
  const snapshot = readRecording(sourceId)
  const dedupeKey = `moss:${sourceId}`
  if (
    getDb()
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.dedupeKey, dedupeKey), inArray(jobs.status, ['queued', 'running'])))
      .get()
  )
    return
  enqueue(
    JOB_KIND,
    {
      sourceId,
      recordingHash: snapshot.hash,
      audioSize: snapshot.size,
      audioMtime: snapshot.mtime,
      transcriptHash: transcriptHash(sourceId),
      voiceEpoch: voiceprintEpoch()
    },
    { dedupeKey }
  )
}

const transcriptHash = (sourceId: string): string =>
  createHash('sha256')
    .update(mossTranscriptRevision(listSegments(sourceId)))
    .digest('hex')

async function refineRecording(payload: MossJobPayload, ctx: JobContext): Promise<{ segments: number; parts: number }> {
  const db = getDb()
  const source = db.select().from(sources).where(eq(sources.id, payload.sourceId)).get()
  if (!source || source.deletedAt) throw new Error('课程资料已删除')
  const snapshot = readRecording(payload.sourceId)
  if (!sameRecording(snapshot, payload)) throw new Error('录音在排队后已改变，请重新发起精修')
  // 指纹随持久化任务保存，自动重试仍以用户点击精修时的版本为准，不能覆盖稍后手工校正的文字。
  if (transcriptHash(source.id) !== payload.transcriptHash) throw new Error('文字稿在排队后已修改，请重新发起精修')
  if (removing || mossStatus().state !== 'ready') throw new Error('精修引擎尚未安装')
  const abort = new AbortController()
  active.add(abort)
  const cancellation = setInterval(() => {
    if (ctx.isCanceled()) abort.abort()
  }, 250)
  let work: string | null = null
  try {
    await mkdir(join(dataDir(), '.tmp'), { recursive: true, mode: 0o700 })
    work = await mkdtemp(join(dataDir(), '.tmp/rec-moss-'))
    setStatus({ running: true, message: null })
    if (ctx.isCanceled()) throw new Error('精修已取消')
    if (!(await verifyRuntime()) || (await sha256File(modelPath())) !== MODEL.sha256)
      throw new Error('精修引擎文件校验失败，请在设置中重新安装')
    await ensureFfmpeg()
    if (abort.signal.aborted) throw new Error('精修已取消')
    const input = join(work, 'input.webm')
    if (source.kind === 'recording') await withRecordingFile(source.id, 'mix', (file) => copyFile(file, input))
    else await copyFile(snapshot.file, input)
    if (!sameRecording(readRecording(payload.sourceId), payload)) throw new Error('复制期间录音已改变，请重新发起精修')
    const wav = join(work, 'recording.wav')
    const decoded = await command(
      ffmpegPath(),
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-i',
        input,
        '-map',
        '0:a:0',
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        '-progress',
        'pipe:1',
        '-y',
        wav
      ],
      AbortSignal.any([abort.signal, AbortSignal.timeout(30 * 60_000)])
    )
    const durations = [...decoded.matchAll(/out_time_(?:us|ms)=(\d+)/g)]
    const duration = Number(durations.at(-1)?.[1] ?? 0) / 1_000_000
    const recordedDuration = snapshot.recording?.chunks.at(-1)!.audioEnd
    if (!duration || (recordedDuration !== undefined && Math.abs(duration - recordedDuration) > 2))
      throw new Error('录音解码时长与完整清单不符，原文字稿已保留')
    const chunks = planMossChunks(duration)
    const recordingRow = recordingForSource(source.id)
    const participants = recordingRow ? (JSON.parse(recordingRow.participants) as string[]) : undefined
    const terms = buildMossHotwords(
      listConcepts().map((concept) => concept.name),
      source.title,
      listSegments(source.id).map((segment) => segment.text),
      {
        extra: recordingRow?.extraHotwords.split(/[,，]/),
        people: listPeople().map((p) => p.name),
        corrections: listCorrections().map((c) => c.to)
      }
    )
    const parts: { chunk: MossChunk; cues: MossCue[] }[] = []
    ctx.progress(0.05)
    for (const [index, chunk] of chunks.entries()) {
      if (abort.signal.aborted) throw new Error('精修已取消')
      let audio = wav
      if (chunks.length > 1) {
        audio = join(work, `part-${index}.wav`)
        await command(
          ffmpegPath(),
          [
            '-hide_banner',
            '-nostdin',
            '-v',
            'error',
            '-ss',
            String(chunk.start),
            '-i',
            wav,
            '-t',
            String(chunk.duration),
            '-c:a',
            'pcm_s16le',
            '-y',
            audio
          ],
          abort.signal
        )
      }
      const prefix = join(work, `result-${index}`)
      await command(
        binaryPath(),
        ['--backend', 'moss-diarize', '-m', modelPath(), '-f', audio, '-ojf', '-of', prefix, ...(terms ? ['--hotwords', terms] : [])],
        AbortSignal.any([abort.signal, AbortSignal.timeout(Math.ceil(Math.max(10 * 60_000, chunk.duration * 8000)))])
      )
      const output = `${prefix}.json`
      if ((await stat(output)).size > 50 * 1024 * 1024) throw new Error('MOSS 输出异常过大，原文字稿已保留')
      const cues = parseMossOutput(JSON.parse(await readFile(output, 'utf8'))).map((cue) => {
        if (cue.start >= chunk.duration || cue.end > chunk.duration + 2) throw new Error('MOSS 时间戳超出录音片段，原文字稿已保留')
        return { ...cue, end: Math.min(cue.end, chunk.duration) }
      })
      parts.push({ chunk, cues })
      ctx.progress(0.05 + 0.9 * ((index + 1) / chunks.length))
      if (audio !== wav) await rm(audio, { force: true })
    }
    let cues: VoiceCue[] = mergeMossChunks(parts)
    if (voiceprintStatus().state === 'ready' && payload.voiceEpoch === voiceprintEpoch()) {
      const tracks: Record<string, string> = {}
      if (recordingRow)
        for (const track of JSON.parse(recordingRow.tracks) as ('mic' | 'system')[]) {
          if (storedRecordingFile(recordingRow.id, `${track}.webm`)) {
            const plain = join(work, `${track}.webm`)
            await withRecordingFile(source.id, track, (file) => copyFile(file, plain))
            tracks[track] = plain
          }
        }
      cues = reviewSpeakers(await extractRecordingVoiceprints(wav, cues, ctx, tracks, abort.signal))
    }
    // 清除完成后可交付文字，但旧任务的中心/认人结果不能重新写回个人库。
    if (payload.voiceEpoch !== voiceprintEpoch()) cues = cues.map(({ embedding: _embedding, ...cue }) => cue)
    // 无 CAM++ 时也把每个块的局部标签独立编号，不能把不同块的 S01 当作同一个人。
    cues = alignSpeakers(cues).cues
    const identified = identifySpeakers(cues, participants)
    cues = identified.cues
    if (snapshot.recording) cues = cues.map((c) => ({ ...c, ...mapMossToVideo([c], snapshot.recording!)[0] }))
    if (!cues.length) throw new Error('精修没有得到有效语音，原文字稿已保留')
    if (abort.signal.aborted || ctx.isCanceled()) throw new Error('精修已取消')
    if (getDb() !== db || !sameRecording(readRecording(source.id), payload)) throw new Error('资料库或录音已改变，请重新发起精修')
    if (db.select({ deletedAt: sources.deletedAt }).from(sources).where(eq(sources.id, source.id)).get()?.deletedAt !== null)
      throw new Error('课程资料已删除，精修结果未写入')
    if (transcriptHash(source.id) !== payload.transcriptHash) throw new Error('文字稿在精修期间已修改，请重新发起精修')
    // 推理期间可能新添幻灯片或正文，因此在最后一次同步写入前重新读取，避免旧快照覆盖它们。
    const segments = db.transaction(() => {
      const count = replaceSegments(source.id, mergeMossSegments(listSegments(source.id), cues))
      saveRecordingSpeakers(source.id, identified.speakers)
      return count
    })
    requestIndex()
    ctx.progress(1)
    return { segments, parts: chunks.length }
  } finally {
    clearInterval(cancellation)
    active.delete(abort)
    setStatus({ running: active.size > 0 })
    if (work) await rm(work, { recursive: true, force: true })
  }
}

export function registerMossJob(): void {
  registerJobKind<MossJobPayload>(JOB_KIND, {
    title: () => 'course.jobs.moss',
    run(payload, ctx) {
      // 同一模型只启动一个实例，防止两个长课任务同时消耗数 GB 内存。
      const task = serial.then(() => {
        if (ctx.isCanceled()) throw new Error('精修已取消')
        return refineRecording(payload, ctx)
      })
      serial = task.then(
        () => {},
        (error: unknown) => {
          log.warn('[moss]', voiceErrorText(error))
        }
      )
      return task
    }
  })
}
