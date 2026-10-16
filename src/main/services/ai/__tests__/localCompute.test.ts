import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ComputeServiceStatus } from '@shared/localCompute'
import type { RuntimeInstallation, RuntimeSpec } from '../llamaRuntime'

const fixture = vi.hoisted(() => ({
  root: '',
  mode: 'auto' as 'auto' | 'cpu',
  current: null as RuntimeInstallation | null,
  cuda: null as RuntimeSpec | null,
  servers: new Map<
    string,
    { snapshot: () => ComputeServiceStatus; isRunning: () => boolean; invalidate: () => void; run: <T>(fn: () => Promise<T>) => Promise<T> }
  >(),
  settingsListener: null as (() => void) | null,
  discover: vi.fn(async () => []),
  retry: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined)
}))
vi.mock('electron', () => ({ app: { getPath: () => fixture.root } }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn() } }))
vi.mock('../../settings', () => ({ getSettings: () => ({ ai: { localCompute: fixture.mode } }) }))
vi.mock('../../../events', () => ({
  emit: vi.fn(),
  onMainEvent: (_name: string, listener: () => void) => {
    fixture.settingsListener = listener
    return () => {
      fixture.settingsListener = null
    }
  }
}))
vi.mock('../llamaRuntime', () => ({
  llamaSupported: () => true,
  runtimeManager: {
    current: async () => fixture.current,
    cudaOption: async () => fixture.cuda,
    installed: async () => null,
    cudaBytes: async () => 4096,
    nvidiaDevices: async () => [],
    snapshot: () => ({ variant: null, downloading: false, receivedBytes: 0, totalBytes: 0, speed: null, mirror: null, error: null }),
    discover: fixture.discover,
    redetect: vi.fn(),
    retryCuda: fixture.retry,
    removeCuda: fixture.remove
  }
}))
vi.mock('../llamaServer', () => ({ computeServers: () => fixture.servers }))
import { loadAccel, markGpuFailure, setCudaDisabled, updateAccel } from '../accel'
import { initLocalCompute, status, redetect, retryCuda, removeCuda } from '../localCompute'

let cleanup: (() => void) | undefined
beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), 'jiwei-compute-controller-'))
  fixture.mode = 'auto'
  fixture.current = null
  fixture.cuda = null
  fixture.servers.clear()
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  rmSync(fixture.root, { recursive: true, force: true })
})

function runningServer(drain: Promise<void> = Promise.resolve()) {
  const snapshot: ComputeServiceStatus = {
    service: 'embedding',
    state: 'running',
    mode: 'cpu',
    variant: 'vulkan',
    backend: 'cpu',
    device: 'CPU',
    offloadedLayers: 0,
    totalLayers: 25,
    reason: 'fixture recovery',
    pendingRestart: false
  }
  const invalidate = vi.fn(() => {
    snapshot.pendingRestart = true
  })
  const called = vi.fn()
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    called()
    await drain
    snapshot.pendingRestart = false
    return fn()
  }
  fixture.servers.set('embedding', { snapshot: () => snapshot, isRunning: () => true, invalidate, run })
  return { invalidate, run: called }
}

it('reports actual per-service diagnostics and never turns discovered hardware into a running GPU claim', async () => {
  runningServer()
  updateAccel((s) => {
    s.devices = [{ id: 'CUDA0', name: 'Fixture NVIDIA', backend: 'cuda', memoryMiB: 8192, freeMiB: 4096 }]
  })
  const result = await status()
  expect(result.services.embedding).toMatchObject({ backend: 'cpu', offloadedLayers: 0, reason: 'fixture recovery' })
  expect(result.services.recognition).toMatchObject({ state: 'idle', backend: null, offloadedLayers: null })
  expect(result.cuda.installedBytes).toBe(4096)
})
it('redetect preserves the only-CPU setting and user CUDA opt-out while restarting the used service safely', async () => {
  fixture.mode = 'cpu'
  setCudaDisabled(true)
  markGpuFailure('vulkan', 'embedding', 'failed')
  const server = runningServer()
  await redetect()
  expect(loadAccel().health).toEqual({})
  expect(loadAccel().cuda.disabled).toBe(true)
  expect(fixture.mode).toBe('cpu')
  expect(server.invalidate).toHaveBeenCalledOnce()
  expect(server.run).toHaveBeenCalledOnce()
  expect(fixture.discover).toHaveBeenCalledOnce()
})
it('serializes maintenance while status stays readable and pending work is visible', async () => {
  let release: () => void = () => undefined
  const drain = new Promise<void>((done) => {
    release = done
  })
  runningServer(drain)
  const first = redetect(),
    second = retryCuda()
  await vi.waitFor(() => expect(fixture.discover).toHaveBeenCalledOnce())
  expect((await status()).maintenance).toBe('redetect')
  expect(fixture.retry).not.toHaveBeenCalled()
  release()
  await first
  await second
  expect(fixture.retry).toHaveBeenCalledOnce()
  expect((await status()).maintenance).toBeNull()
})
it('a failed operation does not poison the queue and removal does not change CPU preference', async () => {
  fixture.mode = 'cpu'
  fixture.retry.mockRejectedValueOnce(new Error('offline'))
  fixture.remove.mockImplementationOnce(async () => {
    setCudaDisabled(true)
  })
  await expect(retryCuda()).rejects.toThrow(/offline/)
  await removeCuda()
  expect(fixture.mode).toBe('cpu')
  expect(loadAccel().cuda.disabled).toBe(true)
})
it('uses the existing settings event so non-settings-page changes also restart the active service', async () => {
  const server = runningServer()
  cleanup = initLocalCompute()
  fixture.mode = 'cpu'
  fixture.settingsListener!()
  await vi.waitFor(() => expect(server.run).toHaveBeenCalledOnce())
})
