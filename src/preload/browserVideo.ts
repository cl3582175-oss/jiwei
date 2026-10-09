/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { ipcRenderer } from 'electron'
import { advanceSlide, frameHash, type SlideState } from '../shared/course'
import { canonicalUrl } from '../shared/browserUrl'
import type { CourseState } from '../shared/types'

// 网页只提供媒体，采集逻辑留在隔离世界。每次导航更换 scope，异步截图与录音不得跨页面发送。
interface Config {
  allowed: boolean
  scope: string
  course: CourseState
}
type CapturableVideo = HTMLVideoElement & { captureStream?: () => MediaStream }
let config: Config | null = null
let documentUrl = location.href
const knownMedia = new Map<HTMLVideoElement, string>()
const blockedMedia = new Map<HTMLVideoElement, string>()
let video: CapturableVideo | null = null
let media = ''
let src = ''
let cleanListeners: (() => void) | null = null
let slides: SlideState | null = null
let frameFailed = false
let audioFailed = false
let localReady = false
let captionsKey = ''
let detectedAt = 0
let noCaptionsSent = false
let sampling = false
let recorder: MediaRecorder | null = null
let splitTimer = 0
let capture = ''
let sequence = 0
let recordingWanted = false
let sendAudio = Promise.resolve()

const id = (): string => [...crypto.getRandomValues(new Uint32Array(4))].map((n) => n.toString(16)).join('-')
const allowed = (): boolean => !!config?.allowed && !!video && video.isConnected
const envelope = () => ({ scope: config!.scope, url: location.href, media })
const same = (p: ReturnType<typeof envelope>): boolean =>
  allowed() && config?.scope === p.scope && media === p.media && location.href === p.url

function report(): void {
  if (!allowed() || !video || !Number.isFinite(video.duration) || video.duration <= 30) return
  ipcRenderer.send('jw-page:video', {
    ...envelope(),
    currentTime: video.currentTime,
    duration: video.duration,
    paused: video.paused,
    rate: video.playbackRate,
    title: (document.title || document.querySelector('h1')?.textContent || '').slice(0, 300),
    ended: video.ended
  })
}

function stopAudio(final = false): void {
  clearTimeout(splitTimer)
  const r = recorder
  if (!r || r.state === 'inactive') return
  // final 随最终 dataavailable 一起发送，主进程等全部块落盘后才宣告完整。
  r.dispatchEvent(new CustomEvent('course-stop', { detail: { final, stopped: performance.now() } }))
  r.stop()
}

function syncAudio(): void {
  recordingWanted =
    allowed() && !!video && !video.paused && !video.ended && !video.seeking && localReady && config?.course.mode !== 'off' && !audioFailed
  if (!recordingWanted) {
    stopAudio(!!video?.ended)
    return
  }
  if (recorder) return
  const v = video!
  const p = envelope()
  try {
    if (!v.captureStream || !MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) throw new Error('Unavailable')
    const stream = v.captureStream()
    const tracks = stream.getAudioTracks()
    stream.getVideoTracks().forEach((t) => t.stop())
    if (!tracks.length) throw new Error('No audio track')
    const audio = new MediaStream(tracks)
    const r = new MediaRecorder(audio, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000 })
    recorder = r
    const chunks: Blob[] = []
    const start = v.currentTime,
      rate = v.playbackRate,
      started = performance.now()
    const seq = sequence++,
      captureId = capture
    let final = false,
      stopped: number | null = null
    r.addEventListener('course-stop', (e) => {
      const detail = (e as CustomEvent<{ final: boolean; stopped: number }>).detail
      final = detail.final
      stopped = detail.stopped
    })
    r.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }
    r.onstop = () => {
      const elapsed = ((stopped ?? performance.now()) - started) / 1000
      final ||= v.ended
      tracks.forEach((t) => t.stop())
      if (recorder === r) recorder = null
      const blob = new Blob(chunks, { type: 'audio/webm;codecs=opus' })
      sendAudio = sendAudio
        .then(async () => {
          if (!same(p)) return
          if (!blob.size || blob.size > 2 * 1024 * 1024) throw new Error('Audio block unavailable')
          const bytes = await blob.arrayBuffer()
          if (same(p))
            ipcRenderer.send('jw-page:audio', {
              ...p,
              capture: captureId,
              sequence: seq,
              start,
              end: Math.min(v.duration, start + elapsed * rate),
              rate,
              elapsed,
              final,
              bytes
            })
        })
        .catch(() => {
          if (!same(p)) return
          audioFailed = true
          recordingWanted = false
          stopAudio()
          ipcRenderer.send('jw-page:audio-error', { ...p, code: 'audio-unavailable' })
        })
      if (recordingWanted) syncAudio()
    }
    r.onerror = () => {
      audioFailed = true
      recordingWanted = false
      stopAudio()
      if (same(p)) ipcRenderer.send('jw-page:audio-error', { ...p, code: 'audio-blocked' })
    }
    // 每块都是完整 WebM，才能独立排队解码。直接把 timeslice 的后续片段交 ffmpeg 会缺容器头。
    r.start()
    ipcRenderer.send('jw-page:audio-start', { ...p, capture: captureId })
    // 末尾不足一个编码帧的独立块只有容器头，无法解码；最后约十秒由ended收尾。
    if ((v.duration - v.currentTime) / rate > 10.25) splitTimer = window.setTimeout(() => stopAudio(), 10000)
  } catch {
    audioFailed = true
    recordingWanted = false
    ipcRenderer.send('jw-page:audio-error', { ...p, code: 'audio-blocked' })
  }
}

function captions(): void {
  if (!allowed() || !video || config?.course.mode !== 'auto') return
  const tracks = [...video.textTracks].filter((t) => t.kind === 'subtitles' || t.kind === 'captions')
  const track = tracks.find((t) => /^zh|^cmn/i.test(t.language)) ?? tracks[0]
  if (track && track.mode === 'disabled') track.mode = 'hidden'
  const cues = track?.cues ? [...track.cues].filter((c): c is VTTCue => 'text' in c) : []
  if (!cues.length) {
    if (!noCaptionsSent && performance.now() - detectedAt > 3000) {
      noCaptionsSent = true
      ipcRenderer.send('jw-page:captions', { ...envelope(), batch: 0, done: true, cues: [] })
    }
    return
  }
  const normalized = cues.map((c) => ({ start: c.startTime, end: c.endTime, text: c.text.replace(/<[^>]*>/g, '').slice(0, 1000) }))
  const key = JSON.stringify(normalized)
  if (key === captionsKey) return
  captionsKey = key
  localReady = false
  syncAudio()
  for (let i = 0; i < normalized.length && i < 100000; i += 500)
    ipcRenderer.send('jw-page:captions', {
      ...envelope(),
      batch: i / 500,
      done: i + 500 >= Math.min(normalized.length, 100000),
      cues: normalized.slice(i, i + 500)
    })
}

async function jpeg(): Promise<ArrayBuffer> {
  const v = video!
  if (!v.videoWidth || !v.videoHeight) throw new Error('Frame unavailable')
  const scale = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight))
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(v.videoWidth * scale)), Math.max(1, Math.round(v.videoHeight * scale)))
  canvas.getContext('2d')!.drawImage(v, 0, 0, canvas.width, canvas.height)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
  if (blob.size > 1.5 * 1024 * 1024) throw new Error('Frame too large')
  return blob.arrayBuffer()
}

async function sample(): Promise<void> {
  if (!allowed() || !video || video.paused || !config?.course.slides || frameFailed || sampling) return
  sampling = true
  const p = envelope(),
    at = video.currentTime
  try {
    if (video.readyState < 2) return
    const canvas = new OffscreenCanvas(32, 32)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(video, 0, 0, 32, 32)
    const rgba = ctx.getImageData(0, 0, 32, 32).data
    const gray = Uint8Array.from({ length: 1024 }, (_, i) =>
      Math.round(rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114)
    )
    const next = advanceSlide(slides, frameHash(gray), performance.now() / 1000)
    slides = next.state
    if (next.save) {
      const bytes = await jpeg()
      if (same(p)) ipcRenderer.send('jw-page:frame', { ...p, t: at, jpeg: bytes })
    }
  } catch {
    frameFailed = true
    if (same(p)) ipcRenderer.send('jw-page:frame-error', { ...p, code: 'frame-blocked' })
  } finally {
    sampling = false
  }
}

function choose(): void {
  if (!config?.allowed) return
  // 网址已经换了但配置还没到时先等待，不能把真正的新视频误记为旧页面的媒体。
  if (canonicalUrl(location.href) !== canonicalUrl(documentUrl)) return
  const videos = [...document.querySelectorAll<HTMLVideoElement>('video')]
  for (const [element, oldSrc] of blockedMedia) if (!element.isConnected || element.currentSrc !== oldSrc) blockedMedia.delete(element)
  knownMedia.clear()
  for (const element of videos) knownMedia.set(element, element.currentSrc)
  const candidates = videos
    .filter((v) => {
      if (blockedMedia.has(v)) return false
      const box = v.getBoundingClientRect(),
        style = getComputedStyle(v)
      return (
        Number.isFinite(v.duration) &&
        v.duration > 30 &&
        box.width > 0 &&
        box.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) !== 0
      )
    })
    .sort(
      (a, b) =>
        b.getBoundingClientRect().width * b.getBoundingClientRect().height -
        a.getBoundingClientRect().width * a.getBoundingClientRect().height
    )
  const next = candidates[0] ?? null
  if (next === video && next?.currentSrc === src) return
  const removed = !next && video && config?.allowed ? envelope() : null
  cleanup()
  if (removed) ipcRenderer.send('jw-page:video-absent', removed)
  video = next
  if (!video) return
  src = video.currentSrc
  media = id()
  capture = id()
  detectedAt = performance.now()
  const v = video
  const event = (): void => {
    report()
    syncAudio()
    captions()
  }
  const boundary = (e: Event): void => {
    recordingWanted = false
    stopAudio()
    // 跳转会留下未观看的区间，必须另起录音，不能把跳过的课程误报为完整录制。
    if (e.type === 'seeking') {
      capture = id()
      sequence = 0
    }
    report()
    if (!v.seeking) syncAudio()
  }
  for (const name of ['play', 'pause', 'seeked', 'ended', 'loadeddata'] as const) v.addEventListener(name, event)
  for (const name of ['seeking', 'ratechange'] as const) v.addEventListener(name, boundary)
  cleanListeners = () => {
    for (const name of ['play', 'pause', 'seeked', 'ended', 'loadeddata'] as const) v.removeEventListener(name, event)
    for (const name of ['seeking', 'ratechange'] as const) v.removeEventListener(name, boundary)
  }
  event()
}

function cleanup(): void {
  recordingWanted = false
  stopAudio()
  cleanListeners?.()
  cleanListeners = null
  video = null
  media = ''
  src = ''
  slides = null
  frameFailed = audioFailed = localReady = false
  captionsKey = ''
  noCaptionsSent = false
  sequence = 0
}

export function configureVideo(next: Config): void {
  // 分P切换通常先pushState再换video；旧画面/字幕必须等媒体真正更换才能绑定到新网址。
  if (next.scope !== config?.scope && canonicalUrl(documentUrl) !== canonicalUrl(location.href))
    for (const [element, oldSrc] of knownMedia) blockedMedia.set(element, oldSrc)
  documentUrl = location.href
  if (next.scope !== config?.scope || !next.allowed) cleanup()
  config = next
  if (!next.allowed) return
  choose()
  if (next.course.mode === 'off') {
    localReady = false
    captionsKey = ''
    noCaptionsSent = false
  }
  syncAudio()
  captions()
}

export function startBrowserVideo(): void {
  // 某些播放器复用同一个video与src，但重新load会先清空旧媒体。
  document.addEventListener(
    'emptied',
    (e) => {
      if (e.target instanceof HTMLVideoElement) blockedMedia.delete(e.target)
    },
    true
  )
  setInterval(() => {
    choose()
    report()
    captions()
  }, 1000)
  // setInterval 的补偿调度可能让下一帧早到几毫秒，连续跳过稳定帧。
  // 从采样完成后计时，保证两次判定至少相隔2秒，也避免后台恢复时堆积截图任务。
  const nextFrame = (): void => {
    void sample().finally(() => window.setTimeout(nextFrame, 2005))
  }
  nextFrame()
  new MutationObserver(choose).observe(document.documentElement, { childList: true, subtree: true })
  ipcRenderer.on('jw-page:record', (_e, p: { enabled: boolean }) => {
    localReady = p.enabled
    if (p.enabled) audioFailed = false
    syncAudio()
  })
  ipcRenderer.on('jw-page:seek', (_e, p: { t: number; play?: boolean }) => {
    if (!allowed() || !video) return
    video.currentTime = Math.min(Math.max(0, p.t), video.duration)
    if (p.play) void video.play().catch(() => {})
  })
  ipcRenderer.on('jw-page:play', () => {
    if (allowed()) void video?.play().catch(() => {})
  })
  ipcRenderer.on('jw-page:pause', () => {
    if (allowed()) video?.pause()
  })
  ipcRenderer.on('jw-page:snapshot', (_e, { requestId }: { requestId: string }) => {
    if (!allowed() || !video) return
    const p = envelope(),
      t = video.currentTime
    void jpeg()
      .then((bytes) => {
        if (same(p)) ipcRenderer.send('jw-page:frame', { ...p, t, jpeg: bytes, requestId })
      })
      .catch(() => {
        if (same(p)) ipcRenderer.send('jw-page:frame-error', { ...p, code: 'frame-blocked', requestId })
      })
  })
}
