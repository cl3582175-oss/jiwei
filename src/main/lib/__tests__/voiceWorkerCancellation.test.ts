import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { extractVoiceprints, type VoiceprintInput } from '../../../worker/voiceprint'

let root = ''
const paths: string[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jiwei-voice-worker-'))
  paths.push(root)
})
afterEach(async () => {
  for (const p of paths.splice(0)) await rm(p, { recursive: true, force: true })
})
async function input(delay = 0): Promise<VoiceprintInput> {
  const pkg = join(root, 'node_modules/sherpa-onnx-node')
  await mkdir(pkg, { recursive: true })
  // 仅原生推理边界替身；真实 worker 循环、进程解码、信号和取消路径。
  await writeFile(
    join(pkg, 'index.js'),
    `exports.SpeakerEmbeddingExtractor=class {createStream(){return {acceptWaveform(){},inputFinished(){}}}isReady(){return true}compute(){return new Float32Array([1,0])}}`
  )
  const ffmpeg = join(root, 'ffmpeg')
  await writeFile(
    ffmpeg,
    `#!${process.execPath}\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(join(root, 'calls'))},'decode\\n');setTimeout(()=>process.stdout.write(Buffer.from(new Float32Array([1,1,1,1]).buffer)),${delay});\n`,
    { mode: 0o755 }
  )
  return {
    file: 'controlled-audio',
    runtime: root,
    ffmpeg,
    model: 'controlled-native-boundary',
    cues: Array.from({ length: 4 }, (_, i) => ({ start: i * 2, end: i * 2 + 2, text: '', speaker: 'S01' }))
  }
}
it.skipIf(process.platform === 'win32')('取消后不再解码剩余句子，下一次任务仍能完成', async () => {
  const p = await input(),
    abort = new AbortController()
  await expect(extractVoiceprints(p, () => abort.abort(), abort.signal)).rejects.toThrow()
  expect((await readFile(join(root, 'calls'), 'utf8')).trim().split('\n')).toEqual(['decode'])
  const next = await extractVoiceprints({ ...p, cues: p.cues.slice(0, 1) }, () => {})
  expect(next[0].embedding).toEqual([1, 0])
})
it.skipIf(process.platform === 'win32')('解码正在运行时取消会终止该进程', async () => {
  const p = await input(1000),
    abort = new AbortController()
  const running = extractVoiceprints(p, () => {}, abort.signal)
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    try {
      await readFile(join(root, 'calls'))
      break
    } catch {
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  abort.abort()
  await expect(running).rejects.toThrow()
})
