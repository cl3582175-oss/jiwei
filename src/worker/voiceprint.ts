import { execFile } from 'child_process'
import { createRequire } from 'module'
import { join } from 'path'
import type { VoiceCue } from '../main/lib/voiceprint'
import { trackHint } from '../main/lib/voiceprint'

interface Stream {
  acceptWaveform(v: { sampleRate: number; samples: Float32Array }): void
  inputFinished(): void
}
interface Extractor {
  createStream(): Stream
  isReady(stream: Stream): boolean
  compute(stream: Stream, external: boolean): Float32Array
}
interface Sherpa {
  SpeakerEmbeddingExtractor: new (config: { model: string; numThreads: number; debug: boolean; provider: string }) => Extractor
}
export interface VoiceprintInput {
  file: string
  runtime: string
  ffmpeg: string
  model: string
  cues: VoiceCue[]
  mic?: string
  system?: string
}
async function samples(file: string, start: number, end: number, ffmpeg: string, signal?: AbortSignal): Promise<Float32Array> {
  signal?.throwIfAborted()
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    let failure: Error | null = null,
      output = Buffer.alloc(0)
    const child = execFile(
      ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-ss',
        String(start),
        '-i',
        file,
        '-t',
        String(Math.min(120, end - start)),
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        'f32le',
        'pipe:1'
      ],
      { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 120000, signal },
      (error, stdout) => {
        failure = error
        output = stdout
      }
    )
    // AbortError 可能先于子进程退出。等 close 后才释放任务/临时目录。
    child.once('close', () => {
      if (signal?.aborted) reject(new Error('Voiceprint task canceled'))
      else if (failure) reject(failure)
      else resolve(output)
    })
  })
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + Math.floor(buffer.byteLength / 4) * 4))
}
const energy = (data: Float32Array): number => data.reduce((n, v) => n + v * v, 0) / Math.max(1, data.length)
/** 原生数组必须复制（false），兼容 Electron 的 V8 内存沙箱。每句单独解码，长录音不整体读入内存。 */
export async function extractVoiceprints(input: VoiceprintInput, progress: (n: number) => void, signal?: AbortSignal): Promise<VoiceCue[]> {
  signal?.throwIfAborted()
  const req = createRequire(join(input.runtime, 'index.js')),
    sherpa = req(join(input.runtime, 'node_modules/sherpa-onnx-node')) as Sherpa
  const extractor = new sherpa.SpeakerEmbeddingExtractor({ model: input.model, numThreads: 2, provider: 'cpu', debug: false })
  const result: VoiceCue[] = []
  for (const [i, cue] of input.cues.entries()) {
    signal?.throwIfAborted()
    const out = { ...cue }
    if (cue.end - cue.start >= 1) {
      const data = await samples(input.file, cue.start, cue.end, input.ffmpeg, signal),
        stream = extractor.createStream()
      stream.acceptWaveform({ sampleRate: 16000, samples: data })
      stream.inputFinished()
      if (energy(data) > 1e-6 && extractor.isReady(stream)) out.embedding = Array.from(extractor.compute(stream, false))
      else out.uncertain = true
    }
    if (input.mic) {
      const mic = energy(await samples(input.mic, cue.start, cue.end, input.ffmpeg, signal)),
        system = input.system ? energy(await samples(input.system, cue.start, cue.end, input.ffmpeg, signal)) : 0
      out.track = trackHint(mic, system)
    }
    result.push(out)
    progress((i + 1) / input.cues.length)
  }
  signal?.throwIfAborted()
  return result
}
