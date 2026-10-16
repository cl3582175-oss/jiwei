import log from 'electron-log/main'
import { LOCAL_EMBEDDING } from '@shared/ai'
import type { ComputeMode, RuntimeVariant } from '@shared/localCompute'
import { gpuFailure, LLAMA_BUILD, loadAccel, markGpuFailure, modelsDir, updateAccel, type AccelState } from './accel'

export interface EmbeddingProbe {
  start(): Promise<void>
  layers(): number | null
  embed(inputs: string[]): Promise<number[][]>
  dispose(): Promise<void>
}
type Result = AccelState['benchmarks'][string]
const attempted = new Set<string>()
const pending = new Map<string, Promise<Result | null>>()
let generation = 0
export function resetBenchmarkAttempts(): void {
  generation++
  attempted.clear()
}

const TEXTS = Array.from(
  { length: 32 },
  (_, i) =>
    LOCAL_EMBEDDING.docPrefix('计算设备健康检查') +
    `第 ${i + 1} 段：学习记录包含概念、例子和回顾。这里使用固定合成文本比较本地 GPU 与 CPU 的向量计算用时，不读取资料库内容。`
)

/** Startup and one warmup are excluded. A failed comparison never becomes an invented speed score. */
export async function runEmbeddingBenchmark(
  variant: RuntimeVariant,
  create: (mode: ComputeMode) => EmbeddingProbe
): Promise<Result | null> {
  const key = `${LLAMA_BUILD}:${variant}`,
    sessionKey = `${modelsDir()}:${key}`
  const previous = loadAccel().benchmarks[key]
  if (previous) return previous
  if (pending.has(sessionKey)) return pending.get(sessionKey)!
  if (attempted.has(sessionKey) || gpuFailure(variant, 'embedding')) return null
  attempted.add(sessionKey)
  const epoch = generation
  const work = (async (): Promise<Result | null> => {
    let gpu: EmbeddingProbe | null = null,
      cpu: EmbeddingProbe | null = null
    let stage: ComputeMode = 'auto'
    try {
      gpu = create('auto')
      await gpu.start()
      if (!(gpu.layers()! > 0)) throw new Error('GPU 基准未确认实际卸载的模型层')
      const measure = async (probe: EmbeddingProbe): Promise<number> => {
        await probe.embed([TEXTS[0]])
        const start = performance.now()
        const vectors = await probe.embed(TEXTS)
        const elapsed = performance.now() - start
        if (vectors.length !== TEXTS.length || vectors.some((v) => !v.length || v.some((n) => !Number.isFinite(n))))
          throw new Error('计算设备基准返回的向量无效')
        return elapsed
      }
      const gpuMs = await measure(gpu)
      await gpu.dispose()
      gpu = null
      stage = 'cpu'
      cpu = create('cpu')
      await cpu.start()
      const cpuMs = await measure(cpu)
      if (epoch !== generation) return null
      const result = { gpuMs, cpuMs, useCpu: gpuMs > cpuMs }
      updateAccel((state) => {
        state.benchmarks[key] = result
      })
      return result
    } catch (error) {
      if (epoch === generation && stage === 'auto')
        markGpuFailure(variant, 'embedding', error instanceof Error ? error.message : String(error))
      log.warn('[llama] compute benchmark incomplete', stage, error)
      return null
    } finally {
      await gpu?.dispose().catch((error) => log.warn('[llama] benchmark stop', error))
      await cpu?.dispose().catch((error) => log.warn('[llama] benchmark stop', error))
    }
  })().finally(() => {
    pending.delete(sessionKey)
  })
  pending.set(sessionKey, work)
  return work
}
