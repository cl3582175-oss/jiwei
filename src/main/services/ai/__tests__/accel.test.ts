import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const fixture = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.root } }))
import {
  chooseVariant,
  computeArgs,
  cudaRetryAllowed,
  detectNvidia,
  gpuFailure,
  loadAccel,
  markGpuFailure,
  modelsDir,
  parseComputeLog,
  parseDevices,
  parseNvidia,
  recordCudaDownloadFailure,
  resetHealth,
  retryCudaDownloads,
  setCudaDisabled,
  updateAccel
} from '../accel'

beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), 'jiwei-accel-policy-'))
})
afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true })
})

describe('compute policy', () => {
  it('pins auto offload and fitting without changing context budgets', () => {
    expect(computeArgs('auto', 'metal', 'embedding')).toEqual(['-ngl', 'auto', '--fit', 'on', '--fit-target', '1024'])
  })
  it('CPU mode disables both text layers and the OCR vision projector', () => {
    expect(computeArgs('cpu', 'cuda13', 'embedding')).toEqual(['-ngl', '0', '--device', 'none'])
    expect(computeArgs('cpu', 'metal', 'recognition')).toEqual(['-ngl', '0', '--device', 'none', '--no-mmproj-offload'])
    expect(computeArgs('auto', 'cpu', 'embedding')).toEqual(['-ngl', '0', '--device', 'none'])
  })
  it('keeps Intel Mac on CPU and Linux on Vulkan', () => {
    expect(chooseVariant('darwin', 'arm64', [])).toBe('metal')
    expect(chooseVariant('darwin', 'x64', [])).toBe('cpu')
    expect(chooseVariant('linux', 'x64', [])).toBe('vulkan')
    expect(() => chooseVariant('linux', 'arm64', [])).toThrow(/不支持/)
  })
  it.each([
    ['580.01', '7.5', 'cuda13'],
    ['581.15', '12.0', 'cuda13'],
    ['579.99', '9.0', 'cuda12'],
    ['580.01', '6.1', 'cuda12'],
    ['551.00', '6.1', 'cuda12'],
    ['550.99', '8.6', 'vulkan']
  ])('selects Windows runtime for driver %s and compute %s', (driver, cc, expected) => {
    expect(chooseVariant('win32', 'x64', parseNvidia(`NVIDIA Test, ${driver}, ${cc}, 8192 MiB`))).toBe(expected)
  })
  it('handles missing/malformed output, memory units and multiple GPU compatibility', async () => {
    expect(parseNvidia('NVIDIA-SMI failed because it could not communicate with the NVIDIA driver')).toEqual([])
    expect(parseNvidia('NVIDIA Test, invalid, N/A, 8192 MiB')).toEqual([])
    expect(parseNvidia('NVIDIA RTX 3060, 580.01, 8.6, 12288 MiB')[0].memoryMiB).toBe(12288)
    const devices = parseNvidia('NVIDIA New, 580.01, 8.6, 8192 MiB\nNVIDIA Old, 580.01, 6.1, 4096 MiB')
    expect(devices).toHaveLength(2)
    expect(chooseVariant('win32', 'x64', devices)).toBe('cuda12')
    expect(chooseVariant('win32', 'x64', devices, true)).toBe('vulkan')
    expect(await detectNvidia('darwin')).toEqual([])
  })
})

describe('actual backend diagnostics', () => {
  it('reads Metal device and all offloaded layers from llama-server stderr', () => {
    expect(
      parseComputeLog(
        'llama_model_load_from_file_impl: using device Metal (Apple M5) - 12288 MiB free\nload_tensors: offloaded 25/25 layers to GPU'
      )
    ).toMatchObject({
      backend: 'metal',
      device: 'Apple M5',
      offloadedLayers: 25,
      totalLayers: 25
    })
  })
  it('reads partial CUDA offload without claiming the entire model is on GPU', () => {
    expect(
      parseComputeLog(
        'ggml_cuda_init: found 1 CUDA devices:\n  Device 0: NVIDIA GeForce RTX 3060, compute capability 8.6, VMM: yes\nload_tensors: offloaded 20/25 layers to GPU'
      )
    ).toMatchObject({
      backend: 'cuda',
      device: 'NVIDIA GeForce RTX 3060',
      offloadedLayers: 20,
      totalLayers: 25
    })
  })
  it('reads Vulkan logs and recognizes zero-layer CPU execution', () => {
    expect(
      parseComputeLog('ggml_vulkan: 0 = AMD Radeon Graphics (RADV) | uma: 1\nload_tensors: offloaded 12/25 layers to GPU')
    ).toMatchObject({ backend: 'vulkan', device: 'AMD Radeon Graphics', offloadedLayers: 12, totalLayers: 25 })
    expect(parseComputeLog('load_tensors: offloaded 0/25 layers to GPU')).toMatchObject({
      backend: 'cpu',
      offloadedLayers: 0,
      totalLayers: 25
    })
    expect(parseComputeLog('loading a model')).toEqual({})
  })
  it('parses device discovery memory without treating it as running inference', () => {
    expect(
      parseDevices(
        'Available devices:\n  Metal: Apple M5 (14336 MiB, 12288 MiB free)\n  CUDA0: NVIDIA RTX 3060 (12288 MiB, 11000 MiB free)'
      )
    ).toEqual([
      { id: 'Metal', name: 'Apple M5', backend: 'metal', memoryMiB: 14336, freeMiB: 12288 },
      { id: 'CUDA0', name: 'NVIDIA RTX 3060', backend: 'cuda', memoryMiB: 12288, freeMiB: 11000 }
    ])
  })
})

describe('persistent recovery policy', () => {
  it('atomically persists per-runtime/service failure and preserves unrelated state', () => {
    markGpuFailure('cuda13', 'embedding', 'driver failed')
    markGpuFailure('vulkan', 'recognition', 'health timeout')
    expect(gpuFailure('cuda13', 'embedding')).toBe('driver failed')
    expect(gpuFailure('cuda13', 'recognition')).toBeNull()
    expect(gpuFailure('vulkan', 'recognition')).toBe('health timeout')
    expect(loadAccel().cuda.preferVulkan).toBe(true)
    expect(JSON.parse(readFileSync(join(modelsDir(), 'accel.json'), 'utf8')).version).toBe(1)
  })
  it('stops after three CUDA download failures and retries only on explicit request', () => {
    for (let i = 0; i < 3; i++) recordCudaDownloadFailure('offline')
    expect(cudaRetryAllowed()).toBe(false)
    expect(loadAccel().cuda.failures).toBe(3)
    retryCudaDownloads()
    expect(cudaRetryAllowed()).toBe(true)
    expect(loadAccel().cuda.failures).toBe(0)
  })
  it('redetect clears health/benchmarks while preserving CPU choice outside this file and CUDA opt-out/failure count', () => {
    setCudaDisabled(true)
    recordCudaDownloadFailure('offline')
    markGpuFailure('metal', 'embedding', 'unavailable')
    updateAccel((s) => {
      s.benchmarks['b11491:metal'] = { gpuMs: 2, cpuMs: 1, useCpu: true }
    })
    resetHealth()
    expect(loadAccel().health).toEqual({})
    expect(loadAccel().benchmarks).toEqual({})
    expect(loadAccel().cuda).toMatchObject({ disabled: true, failures: 1, preferVulkan: false })
    expect(cudaRetryAllowed()).toBe(false)
  })
  it('does not silently enable CUDA after corrupted persistent policy', () => {
    updateAccel(() => undefined)
    writeFileSync(join(modelsDir(), 'accel.json'), '{broken')
    expect(loadAccel().cuda.disabled).toBe(true)
    expect(loadAccel().stateError).toMatch(/读取/)
  })
})
