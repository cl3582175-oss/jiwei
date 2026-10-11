import { app, BrowserWindow, dialog, session, type NativeImage } from 'electron'
import { spawn } from 'child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, join } from 'path'
import { is } from '@electron-toolkit/utils'
import log from 'electron-log/main'
import { LOCAL_VOICES, TTS_VOICES } from '@shared/discover'
import { checkScene, sceneCaptions, type VideoRender, type VideoScene, type VideoVoice, type Work, type WorkExport } from '@shared/works'
import { dataDir } from '../../db'
import { tr } from '../../lib/messages'
import { speechChunks, speechText } from '../../lib/podcast'
import { emit } from '../../events'
import { getSettings } from '../settings'
import { ensureFfmpeg, ffmpegPath } from '../asr'
import { runInWorker } from '../jobs'
import { localSpeechJob, localSpeechReady } from '../discover/localSpeech'
import { synthesize, ttsChars, ttsProviders } from '../discover/tts'
import { recordUsage } from '../agent/usage'
import { withRun } from '../agent/context'
import { perRunLimit } from '../agent/usage'
import { getWork, recordExport } from './index'

// 讲解视频渲染（v0.9 第 1 层视频引擎）：
//   分镜 → 每镜配音（本机 ZipVoice / 云端语音 / 不配音）→ 按旁白定时长与字幕 →
//   离屏窗口逐帧 seek + 截取 → ffmpeg 编码 H.264 + AAC，同时导出 SRT 与分镜表。
// 录制页不联网（独立会话拦截一切非本地请求）、不加载预加载脚本；AI 只填模板参数，不写代码。

const W = 1280,
  H = 720,
  FPS = 30,
  RATE = 24000
const LEAD = 0.35 // 每镜开头留白（秒）
const TAIL = 0.6 // 每镜旁白后的停顿

export const worksDir = (id: string): string => join(dataDir(), 'works', id)

const status = new Map<string, VideoRender>()
const aborters = new Map<string, AbortController>()
function set(id: string, patch: Partial<VideoRender>): void {
  status.set(id, { ...(status.get(id) ?? { status: 'idle', progress: 0, stage: null, message: null, file: null }), ...patch })
  emit('works:changed', {})
}
export function renderStatus(id: string): VideoRender {
  const s = status.get(id)
  if (s) return s
  const file = join(worksDir(id), 'video.mp4')
  return {
    status: existsSync(file) ? 'done' : 'idle',
    progress: existsSync(file) ? 1 : 0,
    stage: null,
    message: null,
    file: existsSync(file) ? file : null
  }
}
export function cancelRender(id: string): void {
  aborters.get(id)?.abort()
}

/* ——— 配音 ——— */

function wavInfo(buf: Buffer): { rate: number; channels: number; bits: number; data: Buffer } {
  let pos = 12,
    rate = RATE,
    channels = 1,
    bits = 16
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4),
      size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(pos + 10)
      rate = buf.readUInt32LE(pos + 12)
      bits = buf.readUInt16LE(pos + 22)
    } else if (id === 'data') return { rate, channels, bits, data: buf.subarray(pos + 8, pos + 8 + Math.min(size, buf.length - pos - 8)) }
    pos += 8 + size + (size % 2)
  }
  throw new Error('Invalid WAV')
}
function wavFile(pcm: Buffer): Buffer {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(36 + pcm.length, 4)
  head.write('WAVEfmt ', 8, 'ascii')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(RATE, 24)
  head.writeUInt32LE(RATE * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36, 'ascii')
  head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm])
}
const silence = (sec: number): Buffer => Buffer.alloc(Math.max(0, Math.round(sec * RATE)) * 2)

function run(args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-1500)))
    const kill = (): void => void p.kill('SIGKILL')
    signal.addEventListener('abort', kill, { once: true })
    p.on('error', reject)
    p.on('close', (code) => {
      signal.removeEventListener('abort', kill)
      if (signal.aborted) reject(new Error('Canceled'))
      else if (code === 0) resolve()
      else reject(new Error(`ffmpeg ${code}: ${err.split('\n').slice(-3).join(' ')}`))
    })
  })
}

/** 任意音频 → 24 kHz 单声道 16 位 PCM */
async function toPcm(file: string, dir: string, signal: AbortSignal): Promise<Buffer> {
  const out = join(dir, `${basename(file)}.norm.wav`)
  await run(['-y', '-i', file, '-ac', '1', '-ar', String(RATE), '-sample_fmt', 's16', out], signal)
  return wavInfo(await readFile(out)).data
}

/** 一镜的配音 PCM；不配音时返回按字数估算时长的静音 */
async function narrate(scene: VideoScene, i: number, voice: VideoVoice, dir: string, signal: AbortSignal): Promise<Buffer> {
  const zh = getSettings().language.startsWith('zh')
  if (voice.engine === 'none') {
    const n = zh ? scene.narration.replace(/\s/g, '').length / 4.2 : scene.narration.split(/\s+/).length / 2.6
    return silence(Math.max(1.5, n))
  }
  if (voice.engine === 'local') {
    if (!localSpeechReady())
      throw new Error(tr('本机语音模型还没有下载，请在设置 → 发现里下载，或选择其他配音', 'The local voice model is not downloaded'))
    const items = speechChunks(scene.narration, 200).map((text, k) => ({ text, out: join(dir, `s${i}-${k}.wav`) }))
    await runInWorker('speech', localSpeechJob(voice.voice ?? LOCAL_VOICES[0].id, items), undefined, signal)
    const parts: Buffer[] = []
    for (const it of items) parts.push(await toPcm(it.out, dir, signal), silence(0.15))
    return Buffer.concat(parts)
  }
  const provider = ttsProviders().find((p) => p.providerId === voice.providerId) ?? ttsProviders()[0]
  if (!provider) throw new Error(tr('还没有可用的语音服务商', 'No speech provider is available'))
  const id = voice.voice ?? TTS_VOICES[provider.engine][0].id
  const parts: Buffer[] = []
  for (const [k, text] of speechChunks(scene.narration, provider.engine === 'qwen' ? 280 : 1500).entries()) {
    signal.throwIfAborted()
    const started = Date.now()
    const audio = await synthesize(provider.providerId, id, text, getSettings().language, signal)
    recordUsage(
      provider.providerId,
      audio.model,
      { inputTokens: ttsChars(text), outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
      undefined,
      Date.now() - started
    )
    const f = join(dir, `s${i}-${k}.${audio.ext}`)
    await writeFile(f, audio.data)
    parts.push(await toPcm(f, dir, signal), silence(0.15))
  }
  return Buffer.concat(parts)
}

/* ——— 字幕 ——— */

const srtTime = (s: number): string => {
  const ms = Math.round(s * 1000)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`
}

/* ——— 录制 ——— */

function renderSession(): Electron.Session {
  const s = session.fromPartition('jiwei-video-render')
  // 录制页只能读本地打包文件（开发时还有本机开发服务器），一切网络请求拒绝
  s.webRequest.onBeforeRequest((d, cb) => {
    const ok =
      /^(file|data|blob|devtools|chrome-extension):/.test(d.url) ||
      (is.dev && !!process.env.ELECTRON_RENDERER_URL && d.url.startsWith(process.env.ELECTRON_RENDERER_URL))
    cb({ cancel: !ok })
  })
  return s
}

async function sceneWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      session: renderSession()
    }
  })
  win.webContents.setFrameRate(60)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (is.dev && process.env.ELECTRON_RENDERER_URL) await win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/scene.html`)
  else await win.loadFile(join(__dirname, '../renderer/scene.html'))
  return win
}

/** seek 到 T 并取下一帧完整画面 */
async function capture(win: BrowserWindow, T: number): Promise<NativeImage> {
  const wc = win.webContents
  await wc.executeJavaScript(`window.jiweiScene.seek(${T.toFixed(4)})`)
  const painted = new Promise<NativeImage>((resolve) => wc.once('paint', (_e, _d, image) => resolve(image)))
  wc.invalidate()
  return painted
}

/** 渲染讲解视频，输出到作品目录；返回 mp4 路径 */
export async function renderVideo(id: string): Promise<string> {
  const w = getWork(id)
  if (w.content?.kind !== 'video' || !w.content.parts.length) throw new Error(tr('先生成分镜', 'Create the storyboard first'))
  if (status.get(id)?.status === 'running') throw new Error(tr('视频正在渲染', 'Already rendering'))
  const scenes = w.content.parts
  for (const s of scenes) {
    const err = checkScene(s)
    if (err) throw new Error(`${s.title || s.template}：${err}`)
  }
  const abort = new AbortController()
  aborters.set(id, abort)
  const signal = abort.signal
  const dir = worksDir(id),
    tmp = join(dir, 'tmp')
  set(id, { status: 'running', progress: 0, stage: 'voice', message: null, file: null })
  let win: BrowserWindow | null = null
  try {
    await mkdir(tmp, { recursive: true })
    await ensureFfmpeg()
    // 1. 配音与时长
    const timings: { start: number; duration: number; captions: { start: number; end: number; text: string }[] }[] = []
    const audio: Buffer[] = []
    let start = 0
    const voice = w.content.voice
    await withRun({ purpose: 'works.video', caller: 'app', perRun: perRunLimit() }, async () => {
      for (const [i, s] of scenes.entries()) {
        signal.throwIfAborted()
        const pcm = await narrate({ ...s, narration: speechText(s.narration) }, i, voice, tmp, signal)
        const spoken = pcm.length / 2 / RATE
        const duration = Math.max(s.template === 'title' ? 3.5 : 3, LEAD + spoken + TAIL)
        timings.push({ start, duration, captions: sceneCaptions(s.narration, LEAD, spoken) })
        audio.push(silence(LEAD), pcm, silence(duration - LEAD - spoken))
        start += duration
        set(id, { progress: ((i + 1) / scenes.length) * 0.3 })
      }
    })
    const total = start
    const audioFile = join(tmp, 'narration.wav')
    await writeFile(audioFile, wavFile(Buffer.concat(audio)))
    // 2. 字幕与分镜表
    const srt = timings
      .flatMap((tm) => tm.captions.map((c) => ({ start: tm.start + c.start, end: tm.start + c.end, text: c.text })))
      .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`)
      .join('\n')
    await writeFile(join(dir, 'video.srt'), srt, 'utf8')
    await writeFile(
      join(dir, 'storyboard.json'),
      JSON.stringify(
        { title: w.title || w.topic, scenes: scenes.map((s, i) => ({ ...s, start: timings[i].start, duration: timings[i].duration })) },
        null,
        2
      ),
      'utf8'
    )
    // 3. 逐帧录制并编码
    set(id, { stage: 'frames' })
    win = await sceneWindow()
    await win.webContents.executeJavaScript(`window.jiweiScene.load(${JSON.stringify({ scenes, timings })})`)
    const out = join(dir, 'video.mp4')
    const ff = spawn(
      ffmpegPath(),
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'bgra',
        '-s',
        `${W}x${H}`,
        '-r',
        String(FPS),
        '-i',
        '-',
        '-i',
        audioFile,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-shortest',
        '-movflags',
        '+faststart',
        out
      ],
      { windowsHide: true }
    )
    let ffErr = ''
    ff.stderr.on('data', (d: Buffer) => (ffErr = (ffErr + d.toString()).slice(-1500)))
    const closed = new Promise<number>((resolve) => ff.on('close', (code) => resolve(code ?? 1)))
    const frames = Math.ceil(total * FPS)
    for (let f = 0; f < frames; f++) {
      if (signal.aborted) {
        ff.kill('SIGKILL')
        throw new Error('Canceled')
      }
      const img = await capture(win, f / FPS)
      const size = img.getSize()
      // 画面尺寸异常（极少见）时缩放到目标尺寸，保证原始帧长度一致
      const bitmap = size.width === W && size.height === H ? img.toBitmap() : img.resize({ width: W, height: H }).toBitmap()
      if (!ff.stdin.write(bitmap)) await new Promise<void>((r) => ff.stdin.once('drain', () => r()))
      if (f % 15 === 0) set(id, { progress: 0.3 + (f / frames) * 0.68 })
    }
    ff.stdin.end()
    const code = await closed
    if (code !== 0) throw new Error(`ffmpeg ${code}: ${ffErr.split('\n').slice(-3).join(' ')}`)
    set(id, { status: 'done', progress: 1, stage: null, file: out })
    log.info('[video] rendered', id, `${total.toFixed(1)}s`, `${frames} frames`)
    return out
  } catch (e) {
    const canceled = signal.aborted
    set(id, {
      status: canceled ? 'idle' : 'error',
      stage: null,
      message: canceled ? null : e instanceof Error ? e.message.slice(0, 300) : String(e)
    })
    throw e
  } finally {
    win?.destroy()
    aborters.delete(id)
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/** 把渲染好的 mp4 / srt / 分镜表另存到用户选择的位置 */
export async function exportVideo(win: BrowserWindow | null, id: string, format: 'mp4' | 'srt' | 'json'): Promise<string | null> {
  const w: Work = getWork(id)
  const src = join(worksDir(id), format === 'json' ? 'storyboard.json' : `video.${format}`)
  if (!existsSync(src)) throw new Error(tr('先渲染视频', 'Render the video first'))
  const name = `${
    (w.title || w.topic)
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .trim()
      .slice(0, 80) || 'video'
  }${format === 'json' ? '-分镜' : ''}.${format}`
  const testDir = !app.isPackaged ? process.env.JIWEI_EXPORT_DIR : undefined
  let file: string
  if (testDir) file = join(testDir, name)
  else {
    const opts = { defaultPath: join(app.getPath('documents'), name), filters: [{ name: format.toUpperCase(), extensions: [format] }] }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    file = r.filePath
  }
  await copyFile(src, file)
  const record: WorkExport = { format, path: file, at: Date.now() }
  recordExport(id, record)
  return file
}
