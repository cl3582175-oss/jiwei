import log from 'electron-log/main'
import type { ComputeService, ComputeServiceStatus, LocalComputeStatus } from '@shared/localCompute'
import { emit, onMainEvent } from '../../events'
import { getSettings } from '../settings'
import { gpuFailure, LLAMA_BUILD, loadAccel, notifyComputeChanged, onComputeChanged, resetHealth } from './accel'
import { resetBenchmarkAttempts } from './llamaBenchmark'
import { computeServers, type LlamaServer } from './llamaServer'
import { llamaSupported, runtimeManager } from './llamaRuntime'

let maintenance: LocalComputeStatus['maintenance'] = null
let tail: Promise<void> = Promise.resolve()
let shutdown: (() => void) | null = null
const mode = () => getSettings().ai.localCompute ?? 'auto'
const usedServers = (): LlamaServer[] =>
  [...computeServers().values()].filter((server) => server.isRunning() || server.snapshot().state === 'error')

async function restart(servers: LlamaServer[]): Promise<void> {
  const results = await Promise.allSettled(
    servers.map(async (server) => {
      server.invalidate()
      // run drains in-flight inference before restarting; no synthetic inference or user data is sent.
      await server.run(async () => undefined)
    })
  )
  const failure = results.find((r) => r.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}
function enqueue(name: NonNullable<LocalComputeStatus['maintenance']>, action: () => Promise<void>): Promise<void> {
  const work = tail
    .catch(() => undefined)
    .then(async () => {
      maintenance = name
      notifyComputeChanged()
      try {
        await action()
      } finally {
        maintenance = null
        notifyComputeChanged()
      }
    })
  tail = work
  return work
}

/** Subscribe after the database is open, once for all windows and all settings writers. */
export function initLocalCompute(): () => void {
  if (shutdown) return shutdown
  let previous = mode()
  let notification: NodeJS.Timeout | null = null
  const offCompute = onComputeChanged(() => {
    if (notification) return
    notification = setTimeout(() => {
      notification = null
      emit('local-compute:changed', {})
    }, 100)
    notification.unref()
  })
  const offSettings = onMainEvent('settings:changed', () => {
    const next = mode()
    if (next === previous) return
    previous = next
    void enqueue('switch', () => restart(usedServers())).catch((error) => log.warn('[compute] device switch failed', error))
  })
  shutdown = () => {
    offCompute()
    offSettings()
    if (notification) clearTimeout(notification)
    shutdown = null
  }
  return shutdown
}

export async function status(): Promise<LocalComputeStatus> {
  const [current, cuda, installedBytes, nvidia] = await Promise.all([
    runtimeManager.current(),
    runtimeManager.cudaOption(),
    runtimeManager.cudaBytes(),
    runtimeManager.nvidiaDevices()
  ])
  const policy = loadAccel(),
    configured = mode()
  const idle = (service: ComputeService): ComputeServiceStatus => ({
    service,
    state: 'idle',
    mode: configured,
    variant: null,
    backend: null,
    device: null,
    offloadedLayers: null,
    totalLayers: null,
    reason: null,
    pendingRestart: false
  })
  const servers = computeServers()
  const services = {
    embedding: servers.get('embedding')?.snapshot() ?? idle('embedding'),
    recognition: servers.get('recognition')?.snapshot() ?? idle('recognition')
  }
  const benchmark = current ? policy.benchmarks[`${LLAMA_BUILD}:${current.variant}`] : null
  const benchmarkState =
    !['win32', 'linux'].includes(process.platform) || configured === 'cpu'
      ? 'not-required'
      : benchmark
        ? benchmark.useCpu
          ? 'cpu'
          : 'passed'
        : current && gpuFailure(current.variant, 'embedding')
          ? 'failed'
          : 'pending'
  return {
    maintenance,
    mode: configured,
    supported: llamaSupported(),
    devices: policy.devices,
    services,
    pendingRestart: maintenance !== null || Object.values(services).some((s) => s.pendingRestart),
    runtime: { ...runtimeManager.snapshot(), variant: current?.variant ?? null },
    benchmark: { state: benchmarkState, gpuMs: benchmark?.gpuMs ?? null, cpuMs: benchmark?.cpuMs ?? null },
    cuda: {
      supported: !!cuda,
      disabled: policy.cuda.disabled,
      failures: policy.cuda.failures,
      retryBlocked: policy.cuda.failures >= 3,
      reason: policy.stateError ?? policy.cuda.reason ?? (nvidia.length && !cuda ? '更新 NVIDIA 驱动后可使用 CUDA 加速' : null),
      installedBytes,
      downloadBytes: cuda && !(await runtimeManager.installed(cuda.variant)) ? cuda.archives.reduce((n, a) => n + a.size, 0) : 0
    }
  }
}

export function redetect(): Promise<void> {
  return enqueue('redetect', async () => {
    const used = usedServers()
    resetHealth()
    resetBenchmarkAttempts()
    runtimeManager.redetect()
    const results = await Promise.allSettled([runtimeManager.discover(), restart(used)])
    const failure = results.find((r) => r.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  })
}
export function retryCuda(): Promise<void> {
  return enqueue('retryCuda', async () => {
    const used = usedServers()
    await runtimeManager.retryCuda()
    await restart(used)
  })
}
export function removeCuda(): Promise<void> {
  return enqueue('removeCuda', async () => {
    const used = usedServers()
    await runtimeManager.removeCuda()
    await restart(used)
  })
}
