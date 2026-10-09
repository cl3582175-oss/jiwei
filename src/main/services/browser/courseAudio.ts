import { app } from 'electron'
import { spawn } from 'child_process'
import { mkdir, writeFile, appendFile, readFile, rename, stat, rm } from 'fs/promises'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import log from 'electron-log/main'
import { CourseAudioSchema } from '@shared/schemas'
import { type CourseCue } from '@shared/course'
import { getDb, type DB } from '../../db'
import { sources } from '../../db/schema'
import { emit } from '../../events'
import { appendCourseAudioPart, courseAudioManifest, hasAppliedAudioPart, type CourseAudioPart } from '../../lib/courseAudio'
import { parseMossRecording } from '../../lib/moss'
import { asrPaths, ffmpegPath } from '../asr'
import { enqueue, registerJobKind, type JobContext } from '../jobs'
import { listSegments, replaceSegments } from '../segments'
import { requestIndex } from '../ai/indexer'
import * as m from './manager'

// 每块保留完整容器与持久化处理记录，崩溃重试不会重新追加用户已经改过的文字。
type Audio = z.infer<typeof CourseAudioSchema>
const Identifier = z.string().regex(/^[\w-]{1,128}$/)
const PartSchema = z.object({
  sequence: z.number().int().min(0).max(100000),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
  rate: z.number().finite().positive().max(16),
  elapsed: z.number().finite().nonnegative().max(60),
  final: z.boolean()
})
const RecordingSchema = z.object({
  version: z.literal(1),
  sourceId: Identifier,
  capture: Identifier,
  duration: z.number().finite().positive(),
  parts: z.array(PartSchema).max(100000)
})
const DecodedSchema = z.object({
  cues: z.array(z.object({ start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative(), text: z.string() })),
  audioDuration: z.number().finite().positive(),
  applied: z.boolean().default(false)
})
type Recording = z.infer<typeof RecordingSchema>
type Decoded = z.infer<typeof DecodedSchema>
const dir = (): string => join(app.getPath('userData'), 'course-audio')
const partDir = (sourceId: string, capture: string): string => join(dir(), sourceId, capture)
const writes = new Map<string, Promise<void>>()
const processing = new Map<string, Promise<void>>()

/** 落盘和发布共用资料级锁，旧录音不能在新录音开始后覆盖完整清单。 */
function serial<T>(queue: Map<string, Promise<void>>, key: string, action: () => Promise<T>): Promise<T> {
  const work = (queue.get(key) ?? Promise.resolve()).then(action)
  const tail = work.then(
    () => {},
    () => {}
  )
  queue.set(key, tail)
  void tail.finally(() => {
    if (queue.get(key) === tail) queue.delete(key)
  })
  return work
}

export function runAudio(cmd: string, args: string[], signal?: AbortSignal): Promise<void> {
  const abort = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)])
  if (abort.aborted) return Promise.reject(new Error('音频处理已取消'))
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    let killTimer: NodeJS.Timeout | undefined
    const stop = (): void => {
      child.kill()
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
      killTimer.unref()
    }
    const cleanup = (): void => {
      abort.removeEventListener('abort', stop)
      if (killTimer) clearTimeout(killTimer)
    }
    child.stderr.on('data', (b: Buffer) => {
      error = (error + b.toString()).slice(-2000)
    })
    child.on('error', (e) => {
      cleanup()
      reject(e)
    })
    child.on('close', (code) => {
      cleanup()
      if (abort.aborted) reject(new Error('音频处理已取消或超时'))
      else if (code === 0) resolve()
      else reject(new Error(`音频解码失败（${code}）：${error.slice(-600)}`))
    })
    abort.addEventListener('abort', stop, { once: true })
    if (abort.aborted) stop()
  })
}

async function readRecording(sourceId: string, capture: string): Promise<Recording | null> {
  try {
    const recording = RecordingSchema.parse(JSON.parse(await readFile(join(partDir(sourceId, capture), 'recording.json'), 'utf8')))
    if (recording.sourceId !== sourceId || recording.capture !== capture) throw new Error('录音清单与资料不匹配')
    return recording
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(`${file}.tmp`, JSON.stringify(value))
  await rename(`${file}.tmp`, file)
}

const captureIsCurrent = async (sourceId: string, capture: string): Promise<boolean> =>
  (await readFile(join(dir(), `${sourceId}.capture`), 'utf8').catch(() => '')) === capture

function sourceIsLive(db: DB, sourceId: string): boolean {
  if (getDb() !== db) return false
  const source = db.select().from(sources).where(eq(sources.id, sourceId)).get()
  return !!source && !source.deletedAt && !source.aiExcluded
}

function updateTabs(sourceId: string, patch: { recordingComplete?: boolean; complete?: boolean; error?: string | null }): void {
  for (const tab of m.browserState().tabs) {
    if (tab.sourceId !== sourceId || tab.incognito || m.isSensitive(tab.id)) continue
    const t = m.getTab(tab.id)
    if (!t) continue
    if (patch.recordingComplete !== undefined) t.course.recordingComplete = patch.recordingComplete
    if (patch.complete) t.course.transcript = 'complete'
    if (patch.error !== undefined) {
      if (patch.error && t.course.error !== patch.error) emit('course:event', { tabId: tab.id, kind: 'error', message: patch.error })
      if (patch.error || t.course.error?.startsWith('audio-')) t.course.error = patch.error
    }
  }
  m.changed()
}

/** 页面重开时只恢复已发布的完整录音，新 capture 会先撤销该清单再写入第一块。 */
export async function recordingComplete(sourceId: string, duration: number): Promise<boolean> {
  if (!Identifier.safeParse(sourceId).success || !Number.isFinite(duration) || duration <= 0) return false
  try {
    const path = join(dir(), `${sourceId}.json`)
    if ((await stat(path)).size > 16 * 1024 * 1024) return false
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
    const manifest = parseMossRecording(raw)
    if (Math.abs(manifest.duration - duration) > 2) return false
    const file = await stat(join(dir(), `${sourceId}.webm`))
    if (!file.isFile() || file.size === 0) return false
    if (typeof raw === 'object' && raw !== null && 'capture' in raw && typeof raw.capture === 'string')
      return captureIsCurrent(sourceId, raw.capture)
    return true
  } catch {
    return false
  }
}

async function initializeCapture(sourceId: string, capture: string, duration: number): Promise<Recording> {
  const recording = RecordingSchema.parse({ version: 1, sourceId, capture, duration, parts: [] })
  const folder = partDir(sourceId, capture)
  await mkdir(folder, { recursive: true })
  await writeJson(join(folder, 'recording.json'), recording)
  await writeJson(join(dir(), `${sourceId}.json`), { version: 1, complete: false, duration, chunks: [], capture })
  await writeFile(join(dir(), `${sourceId}.capture`), capture)
  await writeFile(join(dir(), `${sourceId}.webm`), new Uint8Array())
  updateTabs(sourceId, { recordingComplete: false, error: null })
  return recording
}

/** 开始消息先于第一块到达，避免十秒录制窗口内旧 complete 仍允许精修。 */
export function beginAudioRecording(sourceId: string, capture: string, duration: number): Promise<void> {
  Identifier.parse(sourceId)
  Identifier.parse(capture)
  const db = getDb()
  return serial(writes, sourceId, async () => {
    if (!sourceIsLive(db, sourceId) || (await readRecording(sourceId, capture))) return
    await initializeCapture(sourceId, capture, duration)
  })
}

export function saveAudio(sourceId: string, audio: Audio, duration: number): Promise<void> {
  Identifier.parse(sourceId)
  Identifier.parse(audio.capture)
  const db = getDb()
  return serial(writes, sourceId, async () => {
    if (!sourceIsLive(db, sourceId)) return
    const folder = partDir(sourceId, audio.capture)
    let recording = await readRecording(sourceId, audio.capture)
    if (!recording) {
      if (audio.sequence !== 0) throw new Error('录音首块缺失，请从头重新录制')
      recording = await initializeCapture(sourceId, audio.capture, duration)
    }
    // 开始消息已经选定当前 capture；旧 capture 的首块晚到也不能重新抢回发布资格。
    if (!(await captureIsCurrent(sourceId, audio.capture))) return
    if (recording.parts.some((p) => p.sequence === audio.sequence)) {
      if (await captureIsCurrent(sourceId, audio.capture))
        enqueue('course.audio', { sourceId, capture: audio.capture }, { dedupeKey: `course-audio:${sourceId}:${audio.capture}` })
      return
    }
    await writeFile(join(folder, `${audio.sequence}.webm`), Buffer.from(audio.bytes))
    // 原始追加流仅作为恢复证据；complete=true 的文件总是经 ffmpeg 重新封装后的单一容器。
    await appendFile(join(dir(), `${sourceId}.webm`), Buffer.from(audio.bytes))
    const { sequence, start, end, rate, elapsed, final } = audio
    recording.parts.push({ sequence, start, end, rate, elapsed, final })
    recording.parts.sort((a, b) => a.sequence - b.sequence)
    await writeJson(join(folder, 'recording.json'), recording)
    enqueue('course.audio', { sourceId, capture: audio.capture }, { dedupeKey: `course-audio:${sourceId}:${audio.capture}` })
  })
}

/** 固定 PCM 格式让每块 WAV 可独立交给现有 worker，不依赖前一块的容器头。 */
function wave(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF')
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16000, 24)
  h.writeUInt32LE(32000, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

async function decodePart(folder: string, part: CourseAudioPart, ctx: JobContext, signal: AbortSignal): Promise<Decoded> {
  const result = join(folder, `${part.sequence}.json`)
  if (await stat(result).catch(() => null)) {
    try {
      return DecodedSchema.parse(JSON.parse(await readFile(result, 'utf8')))
    } catch {
      await rename(result, `${result}.invalid-${Date.now()}`)
    }
  }
  await runAudio(
    ffmpegPath(),
    [
      '-nostdin',
      '-v',
      'error',
      '-y',
      '-i',
      join(folder, `${part.sequence}.webm`),
      '-vn',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-f',
      's16le',
      join(folder, `${part.sequence}.pcm`)
    ],
    signal
  )
  const pcm = await readFile(join(folder, `${part.sequence}.pcm`))
  if (!pcm.length) throw new Error('录音块没有可解码的声音')
  await writeFile(join(folder, `${part.sequence}.wav`), wave(pcm))
  const cues = await ctx.worker<CourseCue[]>('transcribe', { file: join(folder, `${part.sequence}.wav`), ...asrPaths() })
  if (ctx.isCanceled() || signal.aborted) throw new Error('音频处理已取消')
  const decoded = DecodedSchema.parse({ cues, audioDuration: pcm.length / 32000, applied: false })
  await writeJson(result, decoded)
  return decoded
}

class IncompleteRecording extends Error {}

async function transcribeRecording(sourceId: string, capture: string, ctx: JobContext): Promise<void> {
  Identifier.parse(sourceId)
  Identifier.parse(capture)
  const db = getDb()
  if (!sourceIsLive(db, sourceId) || !(await captureIsCurrent(sourceId, capture)) || ctx.isCanceled()) return
  const folder = partDir(sourceId, capture)
  const current = await readRecording(sourceId, capture)
  if (!current) throw new Error('录音清单不存在')
  const published: unknown = JSON.parse(await readFile(join(dir(), `${sourceId}.json`), 'utf8'))
  if (
    typeof published === 'object' &&
    published !== null &&
    'complete' in published &&
    published.complete === true &&
    'capture' in published &&
    published.capture === capture
  )
    return
  const parts: CourseAudioPart[] = current.parts.map((part) => ({ ...part }))
  const abort = new AbortController()
  const cancellation = setInterval(() => {
    if (ctx.isCanceled()) abort.abort()
  }, 250)
  try {
    let failure: unknown = null
    for (const [index, part] of parts.entries()) {
      if (ctx.isCanceled() || !sourceIsLive(db, sourceId) || !(await captureIsCurrent(sourceId, capture))) return
      try {
        const decoded = await decodePart(folder, part, ctx, abort.signal)
        part.audioDuration = decoded.audioDuration
        if (!decoded.applied)
          await serial(writes, sourceId, async () => {
            if (ctx.isCanceled() || !sourceIsLive(db, sourceId) || !(await captureIsCurrent(sourceId, capture))) return
            const segments = listSegments(sourceId)
            // 数据库写入后、回执落盘前若发生崩溃，定位标记仍能阻止重试恢复已被人工改过的原句。
            if (!hasAppliedAudioPart(segments, capture, part.sequence)) {
              const merged = appendCourseAudioPart(segments, decoded.cues, part, capture)
              replaceSegments(sourceId, merged)
              if (merged.length > segments.length) requestIndex()
            }
            decoded.applied = true
            await writeJson(join(folder, `${part.sequence}.json`), decoded)
          })
      } catch (error) {
        if (ctx.isCanceled()) return
        failure ??= error
      }
      ctx.progress((index + 1) / parts.length)
    }
    if (failure) throw failure
    if (!parts.at(-1)?.final) return
    const manifest = courseAudioManifest(parts, current.duration)
    if (!manifest.complete) throw new IncompleteRecording('录音有缺失或时间跳转，请从开头连续播放到结束后再精修')
    const concat = join(folder, 'concat.txt')
    await writeFile(concat, parts.map((part) => `file '${part.sequence}.wav'`).join('\n'))
    const output = join(folder, 'complete.webm')
    await runAudio(
      ffmpegPath(),
      [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-f',
        'concat',
        '-safe',
        '1',
        '-i',
        concat,
        '-c:a',
        'libopus',
        '-ar',
        '48000',
        '-b:a',
        '64k',
        output
      ],
      abort.signal
    )
    const published = await serial(writes, sourceId, async () => {
      if (ctx.isCanceled() || !sourceIsLive(db, sourceId) || !(await captureIsCurrent(sourceId, capture))) return false
      await rename(output, join(dir(), `${sourceId}.webm`))
      await writeJson(join(dir(), `${sourceId}.json`), { ...manifest, capture })
      updateTabs(sourceId, { recordingComplete: true, complete: true, error: null })
      return true
    })
    if (!published) return
    // 原始 WebM 和转写回执保留供恢复；最终文件已发布后不再需要庞大的 PCM/WAV 中间件。
    for (const part of parts)
      for (const extension of ['pcm', 'wav'])
        await rm(join(folder, `${part.sequence}.${extension}`), { force: true }).catch((error: unknown) => {
          log.warn('[course-audio] temporary file cleanup failed', error instanceof Error ? error.message : String(error))
        })
  } catch (error) {
    if (!ctx.isCanceled() && sourceIsLive(db, sourceId) && (await captureIsCurrent(sourceId, capture)))
      updateTabs(sourceId, {
        recordingComplete: false,
        error: error instanceof IncompleteRecording ? 'audio-incomplete' : 'audio-transcribe-failed'
      })
    throw error
  } finally {
    clearInterval(cancellation)
  }
}

export function registerCourseAudioJob(): void {
  registerJobKind<{ sourceId: string; capture: string }>('course.audio', {
    title: () => 'course.jobs.audio',
    run: ({ sourceId, capture }, ctx) => serial(processing, `${sourceId}:${capture}`, () => transcribeRecording(sourceId, capture, ctx))
  })
}
