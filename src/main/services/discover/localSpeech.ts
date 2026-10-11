import { app } from 'electron'
import { existsSync } from 'fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { gunzipSync } from 'zlib'
import log from 'electron-log/main'
import type { LocalSpeechStatus } from '@shared/discover'
import { LOCAL_VOICES } from '@shared/discover'
import { modelsDir } from '../ai/localEmbedding'
import { asrPaths, ensureSherpaRuntime, sherpaRuntimeReady } from '../asr'
import { download } from '../download'
import { emit } from '../../events'
import { tr } from '../../lib/messages'
import { speechText } from '../../lib/podcast'

// 本机 AI 语音（每日播客）：sherpa-onnx + ZipVoice distill int8（零样本，语气与节奏跟随参考录音）。
// 用户在设置里选择「本机 AI 语音」后才下载（约 190 MB），可随时删除；合成在后台工作进程中进行。
//   - 模型：k2-fsa/ZipVoice（ModelScope / HF 镜像，哈希与 sherpa-onnx 发布包一致）
//   - 声码器：sherpa-onnx 发布的 vocos_24khz.onnx
//   - 英文发音：espeak-ng 数据的英文子集；中文发音词典随应用分发（resources/zipvoice）
//   - 参考录音：AISHELL-3（Apache-2.0）中的 4 段朗读

const MS = 'https://www.modelscope.cn/models/k2-fsa/ZipVoice/resolve/master/zipvoice_distill'
const HF = (repo: string, path: string): string[] => [
  `https://hf-mirror.com/${repo}/resolve/main/${path}`,
  `https://huggingface.co/${repo}/resolve/main/${path}`
]
const ZV = (path: string): string[] => [`${MS}/${path}`, ...HF('k2-fsa/ZipVoice', `zipvoice_distill/${path}`)]
const ESPEAK = (path: string): string[] => HF('csukuangfj/kokoro-int8-multi-lang-v1_1', `espeak-ng-data/${path}`)
const AISHELL = (path: string): string[] => [
  `https://hf-mirror.com/datasets/AISHELL/AISHELL-3/resolve/main/train/wav/${path}`,
  `https://huggingface.co/datasets/AISHELL/AISHELL-3/resolve/main/train/wav/${path}`
]

/** [本地路径, 大小, sha256, 下载地址] */
const FILES: [string, number, string, string[]][] = [
  ['encoder.int8.onnx', 5570211, 'f2de9a761a85e5ddd125dee6e05bad1c7ee92c11b83b4d775dab216a6aa41379', ZV('text_encoder_int8.onnx')],
  ['decoder.int8.onnx', 124657100, '3cc2e08a96610d7ea1b227398e97cdbbe0414499741d3aec0b8113db2a2ab251', ZV('fm_decoder_int8.onnx')],
  ['tokens.txt', 2570, 'ce98c1afc5f7a20c2484dffdd68a1fff0a4a2cc707328833750c4476c37cdbda', ZV('tokens.txt')],
  [
    'vocos_24khz.onnx',
    54157409,
    'bcb3b970e384161c4d634f0bb9e999ff1c471b34c9bc0b1049a5014065ed3cc0',
    ['https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/vocos_24khz.onnx']
  ],
  ['espeak-ng-data/phontab', 55796, '886f3fa402cb0ba73d483aa8ad000af47a6b7cc06293c75a97913fba68a530f6', ESPEAK('phontab')],
  ['espeak-ng-data/phonindex', 39074, '3ca7b8fa3b42624e4b0f152707e7a39245fce569aa99ea47c055d9e622fcf0c4', ESPEAK('phonindex')],
  ['espeak-ng-data/phondata', 550424, '4e0288957874029a8c3c9f41a8f517ad4bf18127046decbdd4b9d1d6807ce3a3', ESPEAK('phondata')],
  ['espeak-ng-data/intonations', 2040, '3f8af65fd3eda9759a10f021d61361c120871f463515229c925995c7f90918cc', ESPEAK('intonations')],
  ['espeak-ng-data/en_dict', 166944, '71bd330ba8a2e3e8076e631508208ef49449d6147c17b7bd2b4b1e1468292e35', ESPEAK('en_dict')],
  ['espeak-ng-data/lang/gmw/en', 140, '4605d5330801de3641c6e366d15f129ea1f5ffbce8722642aba01ace07ab9c83', ESPEAK('lang/gmw/en')],
  ['espeak-ng-data/lang/gmw/en-US', 257, '41534c2a22df5dd4f1052ff9e1a33a3ea7bff5a26b5c02bdad5ba8ddb7524704', ESPEAK('lang/gmw/en-US')],
  ['voices/f1.wav', 607742, 'ca464904294c4a877e98d67c1818a4df9ab97d1e3dea7267f9b62ff30a9583ff', AISHELL('SSB0016/SSB00160071.wav')],
  ['voices/f2.wav', 440742, 'acc29347665f1aa04750e3bc9d9cc8b375ea9ed09446eaa246f3fb6d99d476e2', AISHELL('SSB0267/SSB02670105.wav')],
  ['voices/m1.wav', 691798, '59fcf44146ec1e249317fb380c3f1072bd1af106723b4e4e8d4f4d36b5a765ee', AISHELL('SSB0273/SSB02730081.wav')],
  ['voices/m2.wav', 552176, 'ad457e8ba91c02d6326a73d95cd50dd113a5da666a101f39511dfc80cc442590', AISHELL('SSB0261/SSB02610030.wav')]
]
/** 参考录音的逐字文本（ZipVoice 要求与录音完全一致） */
const VOICE_TEXT: Record<string, string> = {
  f1: '版权方想要通过分销版权把钱挣回来是绝对不可能的',
  f2: '今年在我们这里应聘的人比去年大概少了百分之二十',
  m1: '中国保险企业正面临着偿付能力受损严重的现实问题',
  m2: '很多受害者在南京瑞驰投资的办公场所商讨解决办法'
}
const LEXICON = 'lexicon.txt'
export const LOCAL_SPEECH_BYTES = FILES.reduce((n, f) => n + f[1], 0) + 1_727_147

const dir = (): string => join(modelsDir(), 'tts', 'zipvoice-distill-int8')
const lexiconSource = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, 'zipvoice', 'lexicon.txt.gz')
    : join(app.getAppPath(), 'resources', 'zipvoice', 'lexicon.txt.gz')

const installed = (): boolean => sherpaRuntimeReady() && [...FILES.map((f) => f[0]), LEXICON].every((f) => existsSync(join(dir(), f)))

export const localSpeechReady = (): boolean => installed()

let status: LocalSpeechStatus = { state: 'missing', progress: 0, bytes: LOCAL_SPEECH_BYTES, speed: null, message: null }
const setStatus = (patch: Partial<LocalSpeechStatus>): void => {
  status = { ...status, ...patch }
  emit('speech:status', status)
}

async function usedBytes(path = dir()): Promise<number> {
  let n = 0
  try {
    for (const e of await readdir(path, { withFileTypes: true }))
      n += e.isDirectory() ? await usedBytes(join(path, e.name)) : (await stat(join(path, e.name))).size
  } catch {
    /* 目录不存在 */
  }
  return n
}

export async function localSpeechStatus(): Promise<LocalSpeechStatus> {
  if (status.state === 'downloading') return status
  const ready = installed()
  if (status.state !== 'error' || ready) status = { ...status, state: ready ? 'ready' : 'missing', message: null }
  return { ...status, bytes: ready ? await usedBytes() : LOCAL_SPEECH_BYTES }
}

let installing: Promise<void> | null = null
let aborter: AbortController | null = null

/** 下载本机语音模型（可重复调用，已完成的文件会跳过） */
export function installLocalSpeech(): Promise<void> {
  if (installing) return installing
  aborter = new AbortController()
  const signal = aborter.signal
  installing = (async () => {
    const done = new Map<string, number>()
    const report = (key: string) => (p: { received: number; speed: number }) => {
      done.set(key, p.received)
      const sum = [...done.values()].reduce((a, b) => a + b, 0)
      setStatus({ state: 'downloading', progress: Math.min(0.999, sum / LOCAL_SPEECH_BYTES), speed: p.speed, message: null })
    }
    try {
      setStatus({ state: 'downloading', progress: 0, message: null })
      await ensureSherpaRuntime()
      for (const [path, size, sha256, urls] of FILES) {
        const dest = join(dir(), path)
        await mkdir(join(dest, '..'), { recursive: true })
        // GitHub Releases 在国内单连接很慢，声码器分段并行下载
        await download(
          { name: path, size, sha256, urls, dest, parallel: path === 'vocos_24khz.onnx' ? 12 : undefined },
          report(path),
          signal
        )
        done.set(path, size)
      }
      await writeFile(join(dir(), LEXICON), gunzipSync(await readFile(lexiconSource())))
      setStatus({ state: 'ready', progress: 1, speed: null, message: null })
      log.info('[speech] installed')
    } catch (e) {
      const msg = signal.aborted ? tr('已取消下载', 'Download canceled') : e instanceof Error ? e.message : String(e)
      log.error('[speech] install failed', msg)
      setStatus({ state: signal.aborted ? 'missing' : 'error', message: signal.aborted ? null : msg, speed: null })
      throw e
    } finally {
      installing = null
      aborter = null
    }
  })()
  return installing
}

export function cancelLocalSpeech(): void {
  aborter?.abort()
}

/** 删除本机语音模型，释放磁盘（sherpa-onnx 运行时与语音转写共用，不删） */
export async function removeLocalSpeech(): Promise<void> {
  cancelLocalSpeech()
  await installing?.catch(() => {})
  await rm(dir(), { recursive: true, force: true })
  setStatus({ state: 'missing', progress: 0, speed: null, message: null })
}


/** 交给后台工作进程的参数 */
export function localSpeechJob(voice: string, items: { text: string; out: string }[], speed = 1) {
  if (!installed()) throw new Error(tr('本机语音模型还没有下载', 'The local voice model is not downloaded yet'))
  const id = LOCAL_VOICES.some((v) => v.id === voice) ? voice : LOCAL_VOICES[0].id
  const d = dir()
  return {
    runtime: asrPaths().runtime,
    model: {
      encoder: join(d, 'encoder.int8.onnx'),
      decoder: join(d, 'decoder.int8.onnx'),
      tokens: join(d, 'tokens.txt'),
      lexicon: join(d, LEXICON),
      dataDir: join(d, 'espeak-ng-data'),
      vocoder: join(d, 'vocos_24khz.onnx')
    },
    reference: { wav: join(d, 'voices', `${id}.wav`), text: VOICE_TEXT[id] },
    items: items.map((x) => ({ ...x, text: speechText(x.text) })),
    speed,
    numSteps: 8
  }
}
