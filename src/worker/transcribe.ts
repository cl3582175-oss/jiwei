import { execFile } from 'child_process'
import { join } from 'path'
import { createRequire } from 'module'
import type { Cue } from '../main/lib/subtitles'
import { localSpeechConfig } from './localSpeechConfig'

// 转写：ffmpeg 流式解码为 16 kHz 单声道 → Silero VAD 切出语音段 → SenseVoice 识别。
// 流式处理，长视频也不会占用大量内存；进度按已处理时长 / 总时长计算。

const SR = 16000
const WINDOW = 512

interface Paths {
  file: string
  runtime: string
  ffmpeg: string
  vad: string
  model: string
  tokens: string
}

interface OfflineStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
}
interface OfflineRecognizer {
  createStream(): OfflineStream
  decode(stream: OfflineStream): void
  getResult(stream: OfflineStream): { text: string }
}
interface Vad {
  isEmpty(): boolean
  front(external: boolean): { start: number; samples: Float32Array }
  pop(): void
  acceptWaveform(samples: Float32Array): void
  flush(): void
}
interface Sherpa {
  Vad: new (
    config: {
      sileroVad: {
        model: string
        threshold: number
        minSpeechDuration: number
        minSilenceDuration: number
        maxSpeechDuration: number
        windowSize: number
      }
      sampleRate: number
      numThreads: number
      provider: string
      debug: boolean
    },
    seconds: number
  ) => Vad
  OfflineRecognizer: new (config: {
    featConfig: { sampleRate: number; featureDim: number }
    modelConfig: {
      senseVoice: { model: string; language: string; useInverseTextNormalization: number }
      tokens: string
      numThreads: number
      provider: string
      debug: boolean
    }
  }) => OfflineRecognizer
}
export async function transcribe(p: Paths, progress: (n: number) => void): Promise<Cue[]> {
  const req = createRequire(join(p.runtime, 'index.js'))
  const sherpa = req(join(p.runtime, 'node_modules/sherpa-onnx-node')) as Sherpa
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: p.vad,
        threshold: 0.5,
        minSpeechDuration: 0.25,
        minSilenceDuration: 0.5,
        maxSpeechDuration: 20,
        windowSize: WINDOW
      },
      sampleRate: SR,
      ...localSpeechConfig('vad')
    },
    60
  )
  const rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SR, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: p.model, language: '', useInverseTextNormalization: 1 },
      tokens: p.tokens,
      ...localSpeechConfig('transcribe')
    }
  })

  const cues: Cue[] = []
  const drain = (): void => {
    while (!vad.isEmpty()) {
      // Electron 的 V8 内存沙箱不允许外部 ArrayBuffer：必须让原生模块复制数据（false）
      const seg = vad.front(false)
      const stream = rec.createStream()
      stream.acceptWaveform({ sampleRate: SR, samples: seg.samples })
      rec.decode(stream)
      const text = String(rec.getResult(stream).text ?? '').trim()
      if (text) cues.push({ start: seg.start / SR, end: (seg.start + seg.samples.length) / SR, text })
      vad.pop()
    }
  }

  await new Promise<void>((resolve, reject) => {
    const ff = execFile(
      p.ffmpeg,
      ['-hide_banner', '-nostdin', '-i', p.file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'],
      { windowsHide: true, encoding: 'buffer' }
    )
    // PCM 必须是 Buffer，不能让 execFile 默认 UTF-8 解码破坏采样。
    // 默认收集器不适用于数小时 PCM；只保留下面的有界流式处理。
    ff.stdout!.removeAllListeners('data')
    ff.stderr!.removeAllListeners('data')
    let duration = 0
    let processed = 0
    let err = ''
    ff.stderr!.on('data', (d: Buffer) => {
      const s = d.toString()
      err = (err + s).slice(-2000)
      const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(s)
      if (m) duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    })
    let pending = Buffer.alloc(0)
    let buf = new Float32Array(0)
    ff.stdout!.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      const n = Math.floor(pending.length / 4)
      const f = new Float32Array(pending.buffer.slice(pending.byteOffset, pending.byteOffset + n * 4))
      pending = pending.subarray(n * 4)
      const merged = new Float32Array(buf.length + f.length)
      merged.set(buf)
      merged.set(f, buf.length)
      buf = merged
      let off = 0
      while (buf.length - off >= WINDOW) {
        vad.acceptWaveform(buf.subarray(off, off + WINDOW))
        off += WINDOW
      }
      buf = buf.slice(off)
      processed += n / SR
      drain()
      if (duration) progress(Math.min(0.99, processed / duration))
    })
    ff.on('error', reject)
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg 解码失败（${code}）：${err.split('\n').slice(-3).join(' ')}`))
      vad.flush()
      drain()
      resolve()
    })
  })
  progress(1)
  return cues
}
