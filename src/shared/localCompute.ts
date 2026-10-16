export type ComputeMode = 'auto' | 'cpu'
export type RuntimeVariant = 'metal' | 'cpu' | 'vulkan' | 'cuda12' | 'cuda13'
export type ComputeService = 'embedding' | 'recognition'
export type ComputeBackend = 'cpu' | 'metal' | 'cuda' | 'vulkan'

export interface GpuDevice {
  id: string
  name: string
  backend: Exclude<ComputeBackend, 'cpu'>
  memoryMiB: number
  freeMiB: number
}

export interface ComputeServiceStatus {
  service: ComputeService
  state: 'idle' | 'starting' | 'running' | 'error'
  mode: ComputeMode
  variant: RuntimeVariant | null
  backend: ComputeBackend | null
  device: string | null
  offloadedLayers: number | null
  totalLayers: number | null
  reason: string | null
  pendingRestart: boolean
}

export interface LocalComputeStatus {
  mode: ComputeMode
  supported: boolean
  devices: GpuDevice[]
  services: Record<ComputeService, ComputeServiceStatus>
  pendingRestart: boolean
  runtime: {
    variant: RuntimeVariant | null
    downloading: boolean
    receivedBytes: number
    totalBytes: number
    speed: number | null
    mirror: string | null
    error: string | null
  }
  cuda: {
    supported: boolean
    disabled: boolean
    failures: number
    retryBlocked: boolean
    reason: string | null
    installedBytes: number
    downloadBytes: number
  }
}
