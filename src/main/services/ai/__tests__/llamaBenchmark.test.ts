import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ComputeMode } from '@shared/localCompute'

const fixture = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.root } }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn() } }))
import { gpuFailure, loadAccel } from '../accel'
import { runEmbeddingBenchmark, resetBenchmarkAttempts, type EmbeddingProbe } from '../llamaBenchmark'

beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), 'jiwei-benchmark-'))
  vi.useFakeTimers()
  resetBenchmarkAttempts()
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(fixture.root, { recursive: true, force: true })
})

function factory(options: { gpuMs?: number; cpuMs?: number; fail?: ComputeMode; layers?: number } = {}) {
  const batches: { mode: ComputeMode; inputs: string[] }[] = []
  const disposed: ComputeMode[] = []
  const create = (mode: ComputeMode): EmbeddingProbe => ({
    start: async () => {
      if (options.fail === mode) throw new Error(`${mode} fixture failure`)
    },
    layers: () => options.layers ?? 25,
    embed: async (inputs) => {
      batches.push({ mode, inputs })
      vi.advanceTimersByTime(mode === 'cpu' ? (options.cpuMs ?? 2) : (options.gpuMs ?? 1))
      return inputs.map(() => [1, 0, 0])
    },
    dispose: async () => {
      disposed.push(mode)
    }
  })
  return { create, batches, disposed }
}
it('compares the same fixed 32 synthetic texts and persists slower GPU -> CPU policy', async () => {
  const probes = factory({ gpuMs: 10, cpuMs: 2 })
  const result = await runEmbeddingBenchmark('vulkan', probes.create)
  expect(result).toMatchObject({ gpuMs: 10, cpuMs: 2, useCpu: true })
  const measured = probes.batches.filter((b) => b.inputs.length === 32)
  expect(measured).toHaveLength(2)
  expect(measured[0].inputs).toEqual(measured[1].inputs)
  expect(new Set(measured[0].inputs).size).toBe(32)
  expect(gpuFailure('vulkan', 'embedding')).toMatch(/基准慢于 CPU/)
  expect(probes.disposed).toEqual(['auto', 'cpu'])
})
it('caches successful GPU health per build/variant and single-flights concurrent callers', async () => {
  const probes = factory()
  const [a, b] = await Promise.all([runEmbeddingBenchmark('cuda13', probes.create), runEmbeddingBenchmark('cuda13', probes.create)])
  expect(a).toEqual(b)
  expect(a?.useCpu).toBe(false)
  await runEmbeddingBenchmark('cuda13', probes.create)
  expect(probes.batches).toHaveLength(4)
  expect(loadAccel().benchmarks['b11491:cuda13']).toMatchObject({ useCpu: false })
})
it('does not call a zero-offload run a GPU benchmark or fabricate timings', async () => {
  const probes = factory({ layers: 0 })
  expect(await runEmbeddingBenchmark('vulkan', probes.create)).toBeNull()
  expect(loadAccel().benchmarks).toEqual({})
  expect(gpuFailure('vulkan', 'embedding')).toMatch(/GPU/)
  expect(probes.disposed).toEqual(['auto'])
})
it('records actual GPU probe failure but does not poison GPU health when the CPU comparison fails', async () => {
  const gpu = factory({ fail: 'auto' })
  expect(await runEmbeddingBenchmark('cuda13', gpu.create)).toBeNull()
  expect(gpuFailure('cuda13', 'embedding')).toMatch(/fixture failure/)
  const cpu = factory({ fail: 'cpu' })
  expect(await runEmbeddingBenchmark('vulkan', cpu.create)).toBeNull()
  expect(gpuFailure('vulkan', 'embedding')).toBeNull()
  expect(loadAccel().benchmarks['b11491:vulkan']).toBeUndefined()
  await runEmbeddingBenchmark('vulkan', cpu.create)
  expect(cpu.disposed).toEqual(['auto', 'cpu'])
  resetBenchmarkAttempts()
  expect(await runEmbeddingBenchmark('vulkan', factory().create)).toMatchObject({ useCpu: false })
})
