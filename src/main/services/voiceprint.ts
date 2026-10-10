import { voiceText } from './voiceMessages'
import { existsSync, statSync } from 'fs'
import { mkdir, rm, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { runInWorker } from './jobs'
import { addVoiceprint, listPeople, savePerson, voiceprintEpoch } from './people'
import type { VoiceprintInput } from '../../worker/voiceprint'
import { join } from 'path'
import { modelsDir } from './ai/localEmbedding'
import { asrPaths, ensureSherpaRuntime, ensureFfmpeg, sherpaRuntimeReady } from './asr'
import { download, sha256File } from './download'
import { emit } from '../events'
import type { VoiceStatus } from '@shared/recording'
import type { VoiceCue } from '../lib/voiceprint'
import type { JobContext } from './jobs'

export const CAMPLUS = {
  file: '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
  size: 28281138,
  sha256: 'f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx'
}
export const voiceprintModelPath = (): string => join(modelsDir(), 'voiceprint', CAMPLUS.file)
let status: VoiceStatus = { state: 'missing', progress: 0, mirror: null, speed: null, message: null, size: CAMPLUS.size }
let installing: Promise<void> | null = null,
  abort: AbortController | null = null
const ready = (): boolean =>
  existsSync(voiceprintModelPath()) && statSync(voiceprintModelPath()).size === CAMPLUS.size && sherpaRuntimeReady()
export function voiceprintStatus(): VoiceStatus {
  if (status.state !== 'downloading' && status.state !== 'error') status.state = ready() ? 'ready' : 'missing'
  return { ...status }
}
function update(patch: Partial<VoiceStatus>): void {
  status = { ...status, ...patch }
  emit('voiceprint:status', voiceprintStatus())
}
export function installVoiceprint(): Promise<void> {
  if (installing) return installing
  abort = new AbortController()
  const signal = abort.signal
  installing = (async () => {
    try {
      update({ state: 'downloading', progress: 0, message: null })
      await ensureSherpaRuntime()
      await ensureFfmpeg()
      await mkdir(join(voiceprintModelPath(), '..'), { recursive: true })
      await download(
        {
          ...CAMPLUS,
          name: 'CAM++',
          dest: voiceprintModelPath(),
          urls: [`https://gh-proxy.com/${CAMPLUS.url}`, `https://ghfast.top/${CAMPLUS.url}`, CAMPLUS.url]
        },
        (p) => update({ progress: p.received / CAMPLUS.size, speed: p.speed, mirror: p.mirror }),
        signal
      )
      update({ state: 'ready', progress: 1, speed: null })
    } catch (error) {
      update({ state: 'error', speed: null, message: String(error) })
      throw error
    }
  })().finally(() => {
    installing = null
    abort = null
  })
  return installing
}
export async function removeVoiceprint(): Promise<void> {
  abort?.abort()
  await installing?.catch(() => {})
  await rm(voiceprintModelPath(), { force: true })
  update({ state: 'missing', progress: 0, message: null })
}
export const stopVoiceprint = (): void => abort?.abort()
export async function enrollVoiceprint(bytes: Uint8Array): Promise<void> {
  const epoch = voiceprintEpoch()
  if (voiceprintStatus().state !== 'ready') throw new Error(voiceText('installVoice'))
  if ((await sha256File(voiceprintModelPath())) !== CAMPLUS.sha256) throw new Error(voiceText('badVoiceModel'))
  const dir = await mkdtemp(join(tmpdir(), 'jiwei-enroll-'))
  try {
    const file = join(dir, 'voice.webm')
    await writeFile(file, bytes, { mode: 0o600 })
    const input: VoiceprintInput = {
      file,
      ...asrPaths(),
      model: voiceprintModelPath(),
      cues: [{ start: 0, end: 20, speaker: 'S01', text: '' }]
    }
    const cues = await runInWorker<VoiceCue[]>('voiceprint', input)
    if (epoch !== voiceprintEpoch()) throw new Error(voiceText('voiceWorkCleared'))
    if (!cues[0]?.embedding) throw new Error(voiceText('noVoice'))
    const person = listPeople().find((p) => p.isMe) ?? savePerson({ name: voiceText('me'), note: '', isMe: true })
    addVoiceprint(person.id, cues[0].embedding, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
export async function extractRecordingVoiceprints(
  file: string,
  cues: VoiceCue[],
  ctx: JobContext,
  tracks?: { mic?: string; system?: string },
  signal?: AbortSignal
): Promise<VoiceCue[]> {
  if (voiceprintStatus().state !== 'ready') return cues
  if ((await sha256File(voiceprintModelPath())) !== CAMPLUS.sha256) throw new Error(voiceText('badVoiceModel'))
  return ctx.worker<VoiceCue[]>('voiceprint', { file, cues, ...asrPaths(), model: voiceprintModelPath(), ...tracks }, signal)
}
