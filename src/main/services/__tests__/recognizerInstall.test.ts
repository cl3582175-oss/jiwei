import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
const fixture = vi.hoisted(() => ({ root: '', blocking: true, updates: [] as { state: string; progress: number }[] }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.root }, nativeImage: {}, net: {}, ipcMain: { on: vi.fn() } }))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../events', () => ({
  emit: (name: string, status: { state: string; progress: number }) => {
    if (name === 'recognition:status') fixture.updates.push(status)
  },
  onMainEvent: () => () => undefined
}))
vi.mock('../settings', () => ({
  getSettings: () => ({
    language: 'zh-CN',
    ai: { recognition: { mode: 'local', auto: false, figures: true, localModel: 'fast', providerId: null, model: null } }
  })
}))
vi.mock('../noteImages', () => ({ queueNoteImages: () => undefined }))
vi.mock('../ai/llamaServer', () => ({
  LlamaServer: class {
    isRunning() {
      return false
    }
    async stop() {}
  }
}))
vi.mock('../ai/localEmbedding', () => ({
  modelsDir: () => join(fixture.root, 'models'),
  llamaSupported: () => true,
  runtimeDownloadSize: async () => 576844403,
  ensureRuntime: async (progress: (p: { received: number; total: number; speed: number; mirror: string }) => void) => {
    if (fixture.blocking) progress({ received: 33423649, total: 33423649, speed: 1, mirror: 'fixture' })
    return '/no-native-model-process'
  }
}))
vi.mock('../download', () => ({
  download: async (spec: { size: number }, progress: (p: { received: number; total: number; speed: number; mirror: string }) => void) =>
    progress({ received: spec.size, total: spec.size, speed: 1, mirror: 'fixture' })
}))
import { installRecognizer } from '../recognize'
beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), 'jiwei-ocr-progress-'))
  fixture.blocking = true
  fixture.updates = []
})
afterEach(() => rmSync(fixture.root, { recursive: true, force: true }))
it('OCR progress uses the actual Vulkan fallback size instead of the initially selected CUDA size', async () => {
  await installRecognizer()
  const progress = fixture.updates.filter((s) => s.state === 'downloading')
  expect(progress.at(-1)?.progress).toBe(0.999)
  expect(progress.find((s) => s.progress > 0)?.progress).toBeCloseTo(33423649 / (33423649 + 811843680 + 115923776), 6)
})
it('a separate background runtime upgrade is not counted as an unfinished blocking OCR download', async () => {
  fixture.blocking = false
  await installRecognizer()
  expect(fixture.updates.filter((s) => s.state === 'downloading').at(-1)?.progress).toBe(0.999)
})
