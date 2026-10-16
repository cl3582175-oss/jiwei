import { app } from 'electron'
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { z } from 'zod'
import type { ComputeMode, ComputeService, ComputeServiceStatus, GpuDevice, RuntimeVariant } from '@shared/localCompute'

export const LLAMA_BUILD = 'b11491'
export const modelsDir = (): string => join(app.getPath('appData'), 'jiwei-models')

const PolicySchema = z.object({
  version: z.literal(1),
  health: z.record(z.string(), z.object({ reason: z.string(), at: z.number() })),
  benchmarks: z.record(z.string(), z.object({ gpuMs: z.number(), cpuMs: z.number(), useCpu: z.boolean() })),
  cuda: z.object({
    build: z.string(),
    failures: z.number().int().nonnegative(),
    disabled: z.boolean(),
    preferVulkan: z.boolean(),
    reason: z.string().nullable()
  }),
  devices: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      backend: z.enum(['metal', 'cuda', 'vulkan']),
      memoryMiB: z.number(),
      freeMiB: z.number()
    })
  ),
  activeVariant: z.enum(['metal', 'cpu', 'vulkan', 'cuda12', 'cuda13']).optional(),
  stateError: z.string().optional()
})
export type AccelState = z.infer<typeof PolicySchema>

const emptyState = (): AccelState => ({
  version: 1,
  health: {},
  benchmarks: {},
  devices: [],
  cuda: { build: LLAMA_BUILD, failures: 0, disabled: false, preferVulkan: false, reason: null }
})

/** Read lazily: tests and alternate user-data roots must be selected before any model access. */
export function loadAccel(): AccelState {
  try {
    const state = PolicySchema.parse(JSON.parse(readFileSync(join(modelsDir(), 'accel.json'), 'utf8')))
    if (state.cuda.build !== LLAMA_BUILD) state.cuda = { ...emptyState().cuda, disabled: state.cuda.disabled }
    return state
  } catch (error) {
    const state = emptyState()
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Unknown/corrupted preferences must not silently re-enable a large automatic CUDA download.
      state.cuda.disabled = true
      state.stateError = '无法读取计算设备记录，请重新检测；CUDA 下载须手动重试'
    }
    return state
  }
}

const listeners = new Set<() => void>()
export function onComputeChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export function notifyComputeChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      /* A notification cannot invalidate a completed state write. */
    }
  }
}

/** Read/modify/rename synchronously so embedding and OCR cannot overwrite each other's policy. */
export function updateAccel(update: (state: AccelState) => void): AccelState {
  const state = loadAccel()
  update(state)
  const valid = PolicySchema.parse(state)
  const directory = modelsDir()
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `accel.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(valid, null, 2), { mode: 0o600 })
    renameSync(temporary, join(directory, 'accel.json'))
  } finally {
    rmSync(temporary, { force: true })
  }
  notifyComputeChanged()
  return valid
}

const healthKey = (variant: RuntimeVariant, service: ComputeService): string => `${LLAMA_BUILD}:${variant}:${service}`
export function gpuFailure(variant: RuntimeVariant, service: ComputeService): string | null {
  const state = loadAccel()
  return (
    state.health[healthKey(variant, service)]?.reason ??
    (state.benchmarks[`${LLAMA_BUILD}:${variant}`]?.useCpu ? 'GPU 基准慢于 CPU，已选择 CPU' : null)
  )
}
export function markGpuFailure(variant: RuntimeVariant, service: ComputeService, reason: string): void {
  updateAccel((state) => {
    state.health[healthKey(variant, service)] = { reason: reason.slice(-1000), at: Date.now() }
    if (variant.startsWith('cuda')) {
      state.cuda.preferVulkan = true
      state.cuda.reason = reason.slice(-1000)
    }
  })
}
export function resetHealth(): void {
  updateAccel((state) => {
    state.health = {}
    state.benchmarks = {}
    state.cuda.preferVulkan = false
    delete state.stateError
  })
}
export function setCudaDisabled(disabled: boolean): void {
  updateAccel((state) => {
    state.cuda.disabled = disabled
  })
}
export function recordCudaDownloadFailure(reason: string): void {
  updateAccel((state) => {
    state.cuda.failures++
    state.cuda.reason = reason.slice(-1000)
  })
}
export function cudaRetryAllowed(): boolean {
  const { cuda } = loadAccel()
  return !cuda.disabled && cuda.failures < 3 && !cuda.preferVulkan
}
export function retryCudaDownloads(): void {
  updateAccel((state) => {
    state.cuda = { ...emptyState().cuda }
  })
}

export interface NvidiaDevice {
  name: string
  driver: number
  computeCapability: number
  memoryMiB: number
}

export function parseNvidia(raw: string): NvidiaDevice[] {
  return raw
    .trim()
    .split(/\r?\n/)
    .flatMap((line) => {
      const columns = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((part) => part.trim().replace(/^"|"$/g, ''))
      if (columns.length !== 4 || !columns[0] || !/^\d+(?:\.\d+)*$/.test(columns[1]) || !/^\d+\.\d+$/.test(columns[2])) return []
      const memory = /^(\d+(?:\.\d+)?)\s*(?:MiB)?$/.exec(columns[3])
      if (!memory) return []
      return [
        { name: columns[0], driver: Number(columns[1].split('.')[0]), computeCapability: Number(columns[2]), memoryMiB: Number(memory[1]) }
      ]
    })
}

export async function detectNvidia(platform: NodeJS.Platform = process.platform): Promise<NvidiaDevice[]> {
  if (platform !== 'win32') return []
  try {
    const { stdout } = await promisify(execFile)(
      'nvidia-smi',
      ['--query-gpu=name,driver_version,compute_cap,memory.total', '--format=csv,noheader'],
      { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024, encoding: 'utf8' }
    )
    return parseNvidia(stdout)
  } catch {
    return []
  }
}

export function chooseVariant(platform: NodeJS.Platform, arch: string, devices: NvidiaDevice[], cudaDisabled = false): RuntimeVariant {
  if (platform === 'darwin' && arch === 'arm64') return 'metal'
  if (platform === 'darwin' && arch === 'x64') return 'cpu'
  if (platform === 'linux' && arch === 'x64') return 'vulkan'
  if (platform !== 'win32' || arch !== 'x64') throw new Error(`不支持本地模型的平台：${platform}-${arch}`)
  if (!cudaDisabled && devices.length) {
    if (devices.every((d) => d.driver >= 580 && d.computeCapability >= 7.5)) return 'cuda13'
    if (devices.every((d) => d.driver >= 551)) return 'cuda12'
  }
  return 'vulkan'
}

export function computeArgs(mode: ComputeMode, variant: RuntimeVariant, service: ComputeService): string[] {
  if (mode === 'cpu' || variant === 'cpu')
    return ['-ngl', '0', '--device', 'none', ...(service === 'recognition' ? ['--no-mmproj-offload'] : [])]
  return ['-ngl', 'auto', '--fit', 'on', '--fit-target', '1024']
}

const backend = (label: string): GpuDevice['backend'] | null => {
  if (/metal|mtl/i.test(label)) return 'metal'
  if (/cuda/i.test(label)) return 'cuda'
  if (/vulkan|vulk/i.test(label)) return 'vulkan'
  return null
}

export function parseDevices(raw: string): GpuDevice[] {
  return [...raw.matchAll(/^\s*(\S+):\s+(.+?)\s+\((\d+) MiB,\s*(\d+) MiB free\)/gm)].flatMap((match) => {
    const kind = backend(match[1])
    return kind ? [{ id: match[1], name: match[2], backend: kind, memoryMiB: Number(match[3]), freeMiB: Number(match[4]) }] : []
  })
}

export function parseComputeLog(raw: string): Partial<ComputeServiceStatus> {
  const result: Partial<ComputeServiceStatus> = {}
  const using = /using device\s+(\S+)\s+\(([^)]+)\)/.exec(raw)
  const metal = /found device:\s*([^\r\n]+)/.exec(raw)
  const cuda = /Device\s+\d+:\s*(.+?),\s*(?:compute|VMM)/.exec(raw)
  const vulkan = /ggml_vulkan:\s*\d+\s*=\s*(.*?)(?:\s*\(|\s*\||$)/m.exec(raw)
  if (using && backend(using[1])) {
    result.backend = backend(using[1])
    result.device = using[2]
  } else if (metal) {
    result.backend = 'metal'
    result.device = metal[1].trim()
  } else if (cuda) {
    result.backend = 'cuda'
    result.device = cuda[1]
  } else if (vulkan) {
    result.backend = 'vulkan'
    result.device = vulkan[1].trim()
  }
  const layers = [...raw.matchAll(/offloaded\s+(\d+)\/(\d+)\s+layers to GPU/g)].at(-1)
  if (layers) {
    result.offloadedLayers = Number(layers[1])
    result.totalLayers = Number(layers[2])
    if (!result.offloadedLayers) {
      result.backend = 'cpu'
      result.device = 'CPU'
    }
  }
  return result
}
