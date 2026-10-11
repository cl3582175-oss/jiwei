import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { createRequire } from 'module'

// 本机语音合成（v0.8 审查后加入）：sherpa-onnx + ZipVoice（零样本，语气与节奏跟随一段参考录音）。
// 在后台工作进程中逐句生成 wav；模型加载较慢，同一模型目录的实例在进程内复用。

export interface SpeechInput {
  runtime: string
  model: { encoder: string; decoder: string; tokens: string; lexicon: string; dataDir: string; vocoder: string }
  /** 参考录音（16 位 PCM wav）与它的逐字文本 */
  reference: { wav: string; text: string }
  /** 每项一句或一小段；out 为输出 wav 的完整路径 */
  items: { text: string; out: string }[]
  speed?: number
  numSteps?: number
}

interface GeneratedAudio {
  samples: Float32Array
  sampleRate: number
}
interface Sherpa {
  OfflineTts: new (config: unknown) => { generate(req: unknown): GeneratedAudio }
  GenerationConfig: new (opts: unknown) => unknown
}

let cached: { key: string; tts: InstanceType<Sherpa['OfflineTts']>; sherpa: Sherpa } | null = null

function load(input: SpeechInput): NonNullable<typeof cached> {
  const key = JSON.stringify(input.model)
  if (cached?.key === key) return cached
  const req = createRequire(join(input.runtime, 'index.js')),
    sherpa = req(join(input.runtime, 'node_modules/sherpa-onnx-node')) as Sherpa
  const tts = new sherpa.OfflineTts({
    model: { zipvoice: input.model, numThreads: 4, provider: 'cpu', debug: false },
    maxNumSentences: 1
  })
  cached = { key, tts, sherpa }
  return cached
}

/** 读取 16 位 PCM 单声道 / 多声道 wav（参考录音），取第一个声道 */
export function readWav(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file')
  let pos = 12,
    channels = 1,
    sampleRate = 16000,
    bits = 16
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4),
      size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(pos + 10)
      sampleRate = buf.readUInt32LE(pos + 12)
      bits = buf.readUInt16LE(pos + 22)
    } else if (id === 'data') {
      if (bits !== 16) throw new Error('Only 16-bit PCM WAV is supported')
      const frames = Math.floor(Math.min(size, buf.length - pos - 8) / (2 * channels)),
        samples = new Float32Array(frames)
      for (let i = 0; i < frames; i++) samples[i] = buf.readInt16LE(pos + 8 + i * 2 * channels) / 32768
      return { samples, sampleRate }
    }
    pos += 8 + size + (size % 2)
  }
  throw new Error('WAV has no data chunk')
}

/** 16 位 PCM 单声道 wav */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + samples.length * 2, 4)
  out.write('WAVEfmt ', 8, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  return out
}

export async function synthesizeLocal(
  input: SpeechInput,
  progress: (n: number) => void,
  signal?: AbortSignal
): Promise<{ out: string; seconds: number }[]> {
  signal?.throwIfAborted()
  const { tts, sherpa } = load(input)
  const ref = readWav(await readFile(input.reference.wav))
  const result: { out: string; seconds: number }[] = []
  for (const [i, item] of input.items.entries()) {
    signal?.throwIfAborted()
    // 原生数组复制出来（enableExternalBuffer: false），兼容 Electron 的 V8 内存沙箱
    const audio = tts.generate({
      text: item.text,
      enableExternalBuffer: false,
      generationConfig: new sherpa.GenerationConfig({
        speed: input.speed ?? 1,
        numSteps: input.numSteps ?? 4,
        referenceAudio: ref.samples,
        referenceSampleRate: ref.sampleRate,
        referenceText: input.reference.text
      })
    })
    await writeFile(item.out, encodeWav(audio.samples, audio.sampleRate))
    result.push({ out: item.out, seconds: audio.samples.length / audio.sampleRate })
    progress((i + 1) / input.items.length)
  }
  return result
}
