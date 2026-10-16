import { beforeEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ blockingRuntime: true, runtimeBytes: 576844403 }))
vi.mock('electron', () => ({ app: { getPath: () => '/isolated-model-test' } }))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn() } }))
vi.mock('../llamaRuntime', () => ({
  llamaSupported: () => true,
  serverBinary: async () => '/isolated-model-test/llama-server',
  runtimeDownloadSize: async () => fixture.runtimeBytes,
  ensureRuntime: async (progress: (p: { received: number; total: number; speed: number; mirror: string }) => void) => {
    if (fixture.blockingRuntime) progress({ received: fixture.runtimeBytes, total: fixture.runtimeBytes, speed: 1, mirror: 'fixture' })
    return '/isolated-model-test/llama-server'
  }
}))
vi.mock('../../download', () => ({
  download: async (spec: { size: number }, progress: (p: { received: number; total: number; speed: number; mirror: string }) => void) =>
    progress({ received: spec.size, total: spec.size, speed: 1, mirror: 'fixture' })
}))
import { install } from '../localEmbedding'

beforeEach(() => {
  fixture.blockingRuntime = true
})
it('uses actual CUDA plus model bytes instead of the former 4 percent runtime assumption', async () => {
  const seen: { received: number; total: number }[] = []
  await install((p) => seen.push(p))
  const total = fixture.runtimeBytes + 309855456
  expect(seen[0]).toMatchObject({ received: fixture.runtimeBytes, total })
  expect(seen.at(-1)).toMatchObject({ received: total, total })
})
it('does not count an unfinished background upgrade as downloaded bytes for model installation', async () => {
  fixture.blockingRuntime = false
  const seen: { received: number; total: number }[] = []
  await install((p) => seen.push(p))
  expect(seen.at(-1)).toMatchObject({ received: 309855456, total: 309855456 })
})
