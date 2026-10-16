import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const fixture = vi.hoisted(() => ({ configurations: new Map<string, unknown>() }))
vi.mock('module', () => ({
  createRequire: () => () => ({
    Vad: class {
      constructor(config: unknown) {
        fixture.configurations.set('vad', config)
      }
      isEmpty() {
        return true
      }
      acceptWaveform() {
        return undefined
      }
      flush() {
        return undefined
      }
    },
    OfflineRecognizer: class {
      constructor(config: unknown) {
        fixture.configurations.set('asr', config)
      }
    },
    SpeakerEmbeddingExtractor: class {
      constructor(config: unknown) {
        fixture.configurations.set('voiceprint', config)
      }
    },
    OfflineTts: class {
      constructor(config: unknown) {
        fixture.configurations.set('tts', config)
      }
      generate() {
        return { samples: new Float32Array([0.1, -0.1, 0, 0.2]), sampleRate: 16000 }
      }
    },
    GenerationConfig: class {}
  })
}))
vi.mock('child_process', () => ({
  execFile: () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.alloc(2048))
      child.emit('close', 0)
    })
    return child
  }
}))
import { transcribe } from './transcribe'
import { extractVoiceprints } from './voiceprint'
import { encodeWav, synthesizeLocal } from './speech'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'jiwei-speech-options-'))
  fixture.configurations.clear()
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))
it('forwards explicit CPU providers and unchanged thread budgets into all native speech constructors', async () => {
  const paths = { file: 'transport-fixture', runtime: directory, ffmpeg: 'transport-fixture', vad: 'vad', model: 'model', tokens: 'tokens' }
  await transcribe(paths, () => undefined)
  await extractVoiceprints({ ...paths, cues: [] }, () => undefined)
  const reference = join(directory, 'reference.wav'),
    output = join(directory, 'out.wav')
  writeFileSync(reference, encodeWav(new Float32Array(16000), 16000))
  await synthesizeLocal(
    {
      runtime: directory,
      model: { encoder: 'encoder', decoder: 'decoder', tokens: 'tokens', lexicon: 'lexicon', dataDir: directory, vocoder: 'vocoder' },
      reference: { wav: reference, text: 'synthetic reference' },
      items: [{ text: 'configuration transport only', out: output }]
    },
    () => undefined
  )
  expect(fixture.configurations.get('vad')).toMatchObject({ provider: 'cpu', numThreads: 1 })
  expect(fixture.configurations.get('asr')).toMatchObject({ modelConfig: { provider: 'cpu', numThreads: 2 } })
  expect(fixture.configurations.get('tts')).toMatchObject({ model: { provider: 'cpu', numThreads: 4 } })
  expect(fixture.configurations.get('voiceprint')).toMatchObject({ provider: 'cpu', numThreads: 2 })
  expect(existsSync(output)).toBe(true)
})
