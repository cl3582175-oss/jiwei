import { create } from 'zustand'
import { api } from '@/lib/utils'
import type { Recording, Track } from '@shared/recording'

interface AudioTrack {
  track: Track
  stream: MediaStream
  recorder: MediaRecorder | null
  analyser: AnalyserNode
  sequence: number
  start: number
  timer?: number
  stopping?: Promise<void>
}
const tracks: AudioTrack[] = []
let context: AudioContext | null = null,
  clock: number | undefined,
  started = 0,
  saved = 0,
  paused = false,
  ending = false,
  writeFailed = false
let writes: Promise<void> = Promise.resolve()
interface State {
  current: Recording | null
  elapsed: number
  levels: Partial<Record<Track, number>>
  opening: boolean
  noteId: string | null
  busy: boolean
  notice: string
  error: string | null
  open(noteId?: string | null): void
}
export const useRecording = create<State>((set) => ({
  current: null,
  elapsed: 0,
  levels: {},
  opening: false,
  noteId: null,
  busy: false,
  notice: '',
  error: null,
  open: (noteId = null) => set({ opening: true, noteId })
}))
export const recordingElapsed = (): number => saved + (paused ? 0 : performance.now() - started)
function cleanup(): void {
  window.clearInterval(clock)
  for (const t of tracks) {
    window.clearTimeout(t.timer)
    if (t.recorder?.state !== 'inactive') t.recorder?.stop()
    t.stream.getTracks().forEach((x) => x.stop())
  }
  tracks.length = 0
  void context?.close()
  context = null
}
function segment(t: AudioTrack, id: string): void {
  const chunks: Blob[] = [],
    at = recordingElapsed()
  const recorder = new MediaRecorder(t.stream, { mimeType: 'audio/webm;codecs=opus' })
  t.recorder = recorder
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }
  recorder.onstop = () => {
    const end = recordingElapsed(),
      durationMs = Math.max(1, end - at),
      startMs = t.start,
      sequence = t.sequence++
    t.start += durationMs
    writes = writes.then(async () => {
      const bytes = new Uint8Array(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer())
      await api.recording.chunk({ id, track: t.track, sequence, startMs, durationMs, bytes })
    })
    void writes.catch(() => {
      if (writeFailed) return
      writeFailed = true
      if (!paused) saved = recordingElapsed()
      paused = true
      ending = true
      // 已保存的清单留给恢复页。失败后立即关闭设备，避免无效写入链持续积累录音。
      cleanup()
      useRecording.setState({ current: null, elapsed: 0, levels: {}, busy: false, error: 'recording.writeFailed' })
    })
    if (!paused && !ending) segment(t, id)
  }
  recorder.start()
  t.timer = window.setTimeout(() => {
    if (recorder.state !== 'inactive') recorder.stop()
  }, 10000)
}
async function stopSegments(): Promise<void> {
  await Promise.all(
    tracks.map(
      (t) =>
        new Promise<void>((resolve) => {
          window.clearTimeout(t.timer)
          const rec = t.recorder
          if (!rec || rec.state === 'inactive') return resolve()
          rec.addEventListener('stop', () => resolve(), { once: true })
          rec.stop()
        })
    )
  )
  await writes
}
export async function startRecording(input: {
  scene: 'meeting' | 'lecture' | 'thought'
  device: string
  system: boolean
  participants: string[]
  extraHotwords: string
  localOnly: boolean
  noteId?: string | null
}): Promise<void> {
  if (useRecording.getState().current) return
  useRecording.setState({ busy: true, error: null, notice: '' })
  let mic: MediaStream | null = null,
    system: MediaStream | null = null
  try {
    if (!(await api.recording.requestMic())) throw new Error('recording.micDenied')
    mic = await navigator.mediaDevices.getUserMedia({ audio: input.device ? { deviceId: { exact: input.device } } : true, video: false })
    if (input.system) {
      const permission = await api.recording.permissions()
      if (permission.system) {
        try {
          const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
          display.getVideoTracks().forEach((t) => t.stop())
          if (display.getAudioTracks().length) system = new MediaStream(display.getAudioTracks())
        } catch {
          /* 无系统音频能力时保留麦克风，提示一次即可。 */
        }
      }
      if (!system) useRecording.setState({ notice: 'recording.systemFallback' })
    }
    const r = await api.recording.begin({
      scene: input.scene,
      tracks: system ? ['mic', 'system'] : ['mic'],
      participants: input.participants,
      extraHotwords: input.extraHotwords,
      localOnly: input.localOnly,
      noteId: input.noteId
    })
    context = new AudioContext()
    saved = 0
    started = performance.now()
    paused = false
    ending = false
    writeFailed = false
    writes = Promise.resolve()
    for (const [track, stream] of [
      ['mic', mic],
      ['system', system]
    ] as const)
      if (stream) {
        const analyser = context.createAnalyser()
        analyser.fftSize = 256
        context.createMediaStreamSource(stream).connect(analyser)
        const t: AudioTrack = { track, stream, analyser, recorder: null, sequence: 0, start: 0 }
        tracks.push(t)
        segment(t, r.id)
      }
    useRecording.setState({ current: r, opening: false, elapsed: 0 })
    clock = window.setInterval(() => {
      const levels: Partial<Record<Track, number>> = {}
      for (const t of tracks) {
        const data = new Uint8Array(t.analyser.fftSize)
        t.analyser.getByteTimeDomainData(data)
        levels[t.track] = paused ? 0 : Math.min(1, Math.sqrt(data.reduce((n, v) => n + ((v - 128) / 128) ** 2, 0) / data.length) * 4)
      }
      useRecording.setState({ elapsed: recordingElapsed(), levels })
    }, 250)
  } catch (error) {
    mic?.getTracks().forEach((t) => t.stop())
    system?.getTracks().forEach((t) => t.stop())
    cleanup()
    const denied = error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)
    useRecording.setState({ error: denied ? 'recording.micDenied' : String(error) })
    throw error
  } finally {
    useRecording.setState({ busy: false })
  }
}
export async function togglePause(): Promise<void> {
  const r = useRecording.getState().current
  if (!r || useRecording.getState().busy) return
  useRecording.setState({ busy: true })
  try {
    if (!paused) {
      // 停止事件先按最后的活动时间写盘，再把主进程切到 paused。
      saved = recordingElapsed()
      paused = true
      ending = true
      await stopSegments()
      ending = false
      await api.recording.pause(r.id, true)
    } else {
      await api.recording.pause(r.id, false)
      paused = false
      started = performance.now()
      for (const t of tracks) segment(t, r.id)
    }
    useRecording.setState({ current: { ...r, status: paused ? 'paused' : 'recording' } })
  } finally {
    useRecording.setState({ busy: false })
  }
}
export async function endRecording(): Promise<Recording | null> {
  const r = useRecording.getState().current
  if (!r) return null
  useRecording.setState({ busy: true })
  ending = true
  if (!paused) {
    saved = recordingElapsed()
    paused = true
  }
  try {
    await stopSegments()
    cleanup()
    return await api.recording.finish(r.id)
  } catch (error) {
    useRecording.setState({ error: String(error) })
    throw error
  } finally {
    cleanup()
    useRecording.setState({ current: null, elapsed: 0, busy: false })
  }
}
